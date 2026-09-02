import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../src/core/events.js';
import { realizedR } from '../src/core/engine.js';
import { MemoryStore } from '../src/data/store.js';
import { Repository } from '../src/data/repo.js';
import {
  shouldBackup,
  snapshotName,
  snapshotsToPrune,
  serialize,
  restore,
  RestoreError,
} from '../src/data/backup.js';

const D = (d) => `2026-08-${String(d).padStart(2, '0')}T14:30:00Z`;

let repo;
beforeEach(() => {
  repo = new Repository(new MemoryStore());
});

async function seed(r = repo) {
  const t = await r.createTrade(
    { ticker: 'DELL', setup: 'Breakout' },
    E.open(D(3), { price: 100, qty: 100, stop: 95 })
  );
  await r.appendEvent(t.id, E.stopChange(D(5), { to: 100, reason: 'structure' }));
  await r.appendEvent(t.id, E.trim(D(7), { price: 110, qty: 50 }));
  await r.setSetting('accountEquity', 50000);
  return t;
}

describe('backup policy', () => {
  const now = new Date('2026-08-28T09:00:00Z');

  test('a journal with no backup always backs up', () => {
    assert.equal(shouldBackup({ lastBackupAt: null, now }).backup, true);
  });

  test('a day since the last backup triggers one', () => {
    const r = shouldBackup({ lastBackupAt: '2026-08-27T08:00:00Z', now });
    assert.equal(r.backup, true);
    assert.match(r.reason, /25h ago/);
  });

  test('a quiet few hours does not', () => {
    assert.equal(
      shouldBackup({ lastBackupAt: '2026-08-28T06:00:00Z', eventCount: 12, eventCountAtLastBackup: 10, now })
        .backup,
      false
    );
  });

  test('a busy morning triggers one regardless of age', () => {
    const r = shouldBackup({
      lastBackupAt: '2026-08-28T06:00:00Z',
      eventCountAtLastBackup: 10,
      eventCount: 16,
      now,
    });
    assert.equal(r.backup, true);
    assert.match(r.reason, /6 events/);
  });

  test('exactly at the event threshold', () => {
    assert.equal(
      shouldBackup({
        lastBackupAt: '2026-08-28T06:00:00Z',
        eventCountAtLastBackup: 10,
        eventCount: 15,
        now,
      }).backup,
      true
    );
  });
});

describe('snapshot naming and pruning', () => {
  test('dated filename', () => {
    assert.equal(snapshotName(new Date('2026-08-28T22:00:00Z')), 'journal-2026-08-28.json');
  });

  test('keeps the newest N and prunes the rest', () => {
    const names = [
      'journal-2026-08-20.json',
      'journal-2026-08-21.json',
      'journal-2026-08-22.json',
      'journal-2026-08-23.json',
    ];
    assert.deepEqual(snapshotsToPrune(names, 2), [
      'journal-2026-08-20.json',
      'journal-2026-08-21.json',
    ]);
  });

  test('leaves unrelated files alone', () => {
    const names = ['journal-2026-08-20.json', 'notes.txt', 'journal-2026-08-21.json'];
    assert.deepEqual(snapshotsToPrune(names, 1), ['journal-2026-08-20.json']);
  });

  test('nothing to prune under the limit', () => {
    assert.deepEqual(snapshotsToPrune(['journal-2026-08-20.json'], 7), []);
  });
});

describe('serialize', () => {
  test('captures everything, with events in order', async () => {
    await seed();
    const snap = await serialize(repo);
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.counts.trades, 1);
    assert.equal(snap.counts.events, 3);
    assert.deepEqual(snap.events.map((e) => e.type), ['OPEN', 'STOP_CHANGE', 'TRIM']);
    assert.equal(snap.settings[0].value, 50000);
  });

  test('a snapshot survives JSON round-tripping', async () => {
    await seed();
    const snap = JSON.parse(JSON.stringify(await serialize(repo)));
    const fresh = new Repository(new MemoryStore());
    const result = await restore(fresh, snap);
    assert.equal(result.failures.length, 0);
  });
});

describe('restore', () => {
  test('rebuilds a journal on an empty device with identical numbers', async () => {
    const t = await seed();
    const before = await repo.getTrade(t.id);
    const snap = await serialize(repo);

    const fresh = new Repository(new MemoryStore());
    const result = await restore(fresh, snap);
    assert.equal(result.trades, 1);
    assert.equal(result.events, 3);

    const after = await fresh.getTrade(t.id);
    assert.equal(realizedR(after), realizedR(before));
    assert.equal(after.activeStop, before.activeStop);
    assert.equal(await fresh.getSetting('accountEquity'), 50000);
  });

  test('replace wipes whatever was there', async () => {
    await seed();
    const snap = await serialize(repo);

    const other = new Repository(new MemoryStore());
    await other.createTrade({ ticker: 'JPM' }, E.open(D(4), { price: 50, qty: 10, stop: 47 }));
    await restore(other, snap, { mode: 'replace' });

    const tickers = (await other.listTrades()).map((t) => t.ticker);
    assert.deepEqual(tickers, ['DELL'], 'the local JPM trade is gone');
  });

  test('merge unions by id and keeps local on collision', async () => {
    await seed();
    const snap = await serialize(repo);

    const other = new Repository(new MemoryStore());
    await other.createTrade({ ticker: 'JPM' }, E.open(D(4), { price: 50, qty: 10, stop: 47 }));
    await restore(other, snap, { mode: 'merge' });

    const tickers = (await other.listTrades()).map((t) => t.ticker).sort();
    assert.deepEqual(tickers, ['DELL', 'JPM'], 'both survive');
  });

  test('merging the same snapshot twice is a no-op', async () => {
    await seed();
    const snap = await serialize(repo);
    const fresh = new Repository(new MemoryStore());
    await restore(fresh, snap, { mode: 'merge' });
    const second = await restore(fresh, snap, { mode: 'merge' });
    assert.equal(second.trades, 1);
    assert.equal(second.events, 3, 'append-only merge is idempotent');
  });

  test('a newer schema is refused rather than half-read', async () => {
    await assert.rejects(
      () => restore(repo, { schemaVersion: 99, trades: [], events: [] }),
      RestoreError
    );
  });

  test('malformed backups are rejected', async () => {
    await assert.rejects(() => restore(repo, null), RestoreError);
    await assert.rejects(() => restore(repo, { trades: [], events: [] }), RestoreError);
    await assert.rejects(() => restore(repo, { schemaVersion: 1, trades: [] }), RestoreError);
    await assert.rejects(() => restore(repo, { schemaVersion: 1, trades: [], events: [] }, { mode: 'x' }));
  });

  test('a corrupt log is reported rather than silently restored', async () => {
    const t = await seed();
    const snap = await serialize(repo);
    // Corrupt the trim so it exceeds the position.
    snap.events.find((e) => e.type === 'TRIM').payload.qty = 5000;

    const fresh = new Repository(new MemoryStore());
    const result = await restore(fresh, snap);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].ticker, 'DELL');
    assert.match(result.failures[0].error, /trim more than/i);
  });
});
