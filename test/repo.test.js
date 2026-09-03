import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../src/core/events.js';
import { realizedR, currentR } from '../src/core/engine.js';
import { MemoryStore } from '../src/data/store.js';
import { Repository, sortEvents } from '../src/data/repo.js';

const near = (a, b, msg, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${msg ?? ''} expected ${b}, got ${a}`);

const D = (d, h = 14) => `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:30:00Z`;

let repo;
beforeEach(() => {
  repo = new Repository(new MemoryStore());
});

const openDell = () =>
  repo.createTrade(
    { ticker: 'DELL', setup: 'Breakout', entryEmotion: 'Calm' },
    E.open(D(3), { price: 100, qty: 100, stop: 95 })
  );

describe('creating trades', () => {
  test('a trade is created with its OPEN event', async () => {
    const t = await openDell();
    assert.equal(t.ticker, 'DELL');
    assert.equal(t.setup, 'Breakout');
    near(t.R, 500);
    assert.equal(t.status, 'OPEN');
  });

  test('an invalid open is rejected and leaves nothing behind', async () => {
    await assert.rejects(() =>
      repo.createTrade({ ticker: 'BAD' }, E.open(D(3), { price: 100, qty: 10, stop: 105 }))
    );
    assert.equal((await repo.listTrades()).length, 0, 'no orphan trade record');
  });

  test('createTrade insists on an OPEN event', async () => {
    await assert.rejects(() => repo.createTrade({ ticker: 'X' }, E.note(D(3), { text: 'hi' })));
  });
});

describe('appending events', () => {
  test('normal management flow', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.stopChange(D(5), { to: 100, reason: 'structure' }));
    await repo.appendEvent(t.id, E.trim(D(7), { price: 110, qty: 50 }));
    await repo.appendEvent(t.id, E.close(D(9), { price: 108, reason: 'trailing stop' }));

    const s = await repo.getTrade(t.id);
    assert.equal(s.status, 'CLOSED');
    near(realizedR(s), 1.8);
    assert.equal(s.stopChanges, 1);
  });

  test('an append that would break the log is rejected', async () => {
    const t = await openDell();
    await assert.rejects(() => repo.appendEvent(t.id, E.trim(D(5), { price: 110, qty: 101 })));

    const s = await repo.getTrade(t.id);
    near(s.qty, 100, 'position untouched');
    assert.equal(s.events.length, 1, 'the bad event was never written');
  });

  test('cannot append to a closed trade', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.close(D(9), { price: 108 }));
    await assert.rejects(() => repo.appendEvent(t.id, E.add(D(10), { price: 108, qty: 10 })));
  });

  test('unknown trade id', async () => {
    await assert.rejects(() => repo.appendEvent('nope', E.note(D(5), { text: 'x' })));
  });
});

describe('ordering', () => {
  test('same-timestamp events keep insertion order', () => {
    const evs = [
      { at: D(5), seq: 2, tag: 'b' },
      { at: D(5), seq: 1, tag: 'a' },
      { at: D(4), seq: 9, tag: 'earlier' },
    ];
    assert.deepEqual(sortEvents(evs).map((e) => e.tag), ['earlier', 'a', 'b']);
  });

  test('a backdated event sorts into place and changes the numbers', async () => {
    const t = await openDell();
    // Logged on the 9th, but it happened on the 5th.
    await repo.appendEvent(t.id, E.add(D(9), { price: 120, qty: 100 }));
    const withLateAdd = await repo.getTrade(t.id);
    near(withLateAdd.avgCost, 110, 'add at 120 on top of 100');

    const t2 = await repo.createTrade({ ticker: 'X' }, E.open(D(3), { price: 100, qty: 100, stop: 95 }));
    await repo.appendEvent(t2.id, E.trim(D(9), { price: 130, qty: 50 }));
    await repo.appendEvent(t2.id, E.add(D(5), { price: 120, qty: 100 })); // backdated before the trim
    const s = await repo.getTrade(t2.id);
    // add first -> avg 110, then trim 50 @ 130 -> realized 50 * 20 = 1000
    near(s.avgCost, 110, 'the backdated add is applied before the trim');
    near(s.realizedPnl, 1000);
    near(s.qty, 150);
  });

  test('order by timestamp, not by write order', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.stopChange(D(8), { to: 104 }));
    await repo.appendEvent(t.id, E.stopChange(D(6), { to: 99 })); // written later, happened earlier
    const s = await repo.getTrade(t.id);
    near(s.activeStop, 104, 'the latest stop by time wins');
    assert.deepEqual(s.stopHistory.map((h) => h.to), [95, 99, 104]);
  });
});

describe('editing', () => {
  test('a correction updates the projection and logs that it happened', async () => {
    const t = await openDell();
    const trim = await repo.appendEvent(t.id, E.trim(D(7), { price: 110, qty: 50 }));

    await repo.editEvent(trim.id, { price: 112 }, { at: D(8) });

    const s = await repo.getTrade(t.id);
    near(s.realizedPnl, 50 * 12, 'corrected fill is what counts');

    const edits = s.events.filter((e) => e.type === 'TRADE_EDIT');
    assert.equal(edits.length, 1);
    assert.equal(edits[0].payload.field, 'price');
    assert.equal(edits[0].payload.from, 110);
    assert.equal(edits[0].payload.to, 112);
  });

  test('a correction that would break the log is rejected', async () => {
    const t = await openDell();
    const trim = await repo.appendEvent(t.id, E.trim(D(7), { price: 110, qty: 50 }));
    await assert.rejects(() => repo.editEvent(trim.id, { qty: 500 }));

    const s = await repo.getTrade(t.id);
    near(s.qty, 50, 'unchanged');
  });
});

describe('listing and the activity log', () => {
  test('filter by status', async () => {
    const a = await openDell();
    await repo.createTrade({ ticker: 'JPM' }, E.open(D(4), { price: 50, qty: 100, stop: 47 }));
    await repo.appendEvent(a.id, E.close(D(9), { price: 120 }));

    assert.equal((await repo.listTrades()).length, 2);
    assert.equal((await repo.listTrades({ status: 'OPEN' }))[0].ticker, 'JPM');
    assert.equal((await repo.listTrades({ status: 'CLOSED' }))[0].ticker, 'DELL');
  });

  test('the feed is newest first with tickers joined in', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.stopChange(D(5), { to: 100 }));
    await repo.appendJournal({ type: 'DAILY_NOTE', at: D(6), payload: { text: 'quiet day' } });

    const log = await repo.activityLog();
    assert.equal(log.length, 3);
    assert.equal(log[0].type, 'DAILY_NOTE');
    assert.equal(log[1].type, 'STOP_CHANGE');
    assert.equal(log[1].ticker, 'DELL', 'ticker joined for the UI');
    assert.equal(log[2].type, 'OPEN');
  });

  test('filters by range, type and ticker', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.stopChange(D(5), { to: 100 }));
    await repo.appendEvent(t.id, E.note(D(6), { text: 'holding' }));
    const j = await repo.createTrade({ ticker: 'JPM' }, E.open(D(6), { price: 50, qty: 10, stop: 47 }));
    await repo.appendEvent(j.id, E.stopChange(D(7), { to: 49 }));

    assert.equal((await repo.activityLog({ from: D(6), to: D(7, 23) })).length, 3);
    assert.equal((await repo.activityLog({ types: ['STOP_CHANGE'] })).length, 2);
    assert.equal((await repo.activityLog({ ticker: 'DELL' })).length, 3);
  });

  test('event count covers trade and account events', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.note(D(5), { text: 'x' }));
    await repo.appendJournal({ type: 'DAILY_NOTE', at: D(6), payload: { text: 'y' } });
    assert.equal(await repo.eventCount(), 3);
  });
});

describe('settings', () => {
  test('round trip with a fallback', async () => {
    assert.equal(await repo.getSetting('accountEquity', 50000), 50000);
    await repo.setSetting('accountEquity', 62000);
    assert.equal(await repo.getSetting('accountEquity'), 62000);
  });
});

describe('a realistic managed trade', () => {
  test('DELL from the spec, end to end', async () => {
    const t = await repo.createTrade(
      { ticker: 'DELL', setup: 'Breakout' },
      E.open('2026-08-21T13:35:00Z', { price: 471, qty: 42, stop: 461 })
    );
    await repo.appendEvent(
      t.id,
      E.stopChange('2026-08-27T13:40:00Z', { to: 474, reason: 'structure', source: 'rule' })
    );
    await repo.appendEvent(t.id, E.trim('2026-08-29T14:02:00Z', { price: 491, qty: 21 }));
    await repo.appendEvent(
      t.id,
      E.close('2026-09-02T19:55:00Z', { price: 486, reason: 'trailing stop' })
    );

    const s = await repo.getTrade(t.id);
    near(s.R, 420, 'R = 10 * 42');
    // 21 * 20 = 420, then 21 * 15 = 315 -> 735 / 420
    near(realizedR(s), 1.75);
    assert.equal(s.stopChanges, 1);
    assert.equal(s.stopHistory.at(-1).source, 'rule');
  });
});

describe('activity log enrichment', () => {
  test('stop changes carry the stop they moved from', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.stopChange(D(5), { to: 100 }));
    await repo.appendEvent(t.id, E.stopChange(D(7), { to: 104 }));

    const log = await repo.activityLog({ types: ['STOP_CHANGE'] });
    assert.equal(log[0].payload.from, 100, 'the second move came from 100');
    assert.equal(log[0].payload.to, 104);
    assert.equal(log[1].payload.from, 95, 'the first came from the initial stop');
  });

  test('a rule override records the stop that was kept', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.stopChange(D(5), { to: 100 }));
    await repo.appendEvent(t.id, E.ruleOverride(D(6), { ruleStop: 110, reason: 'gap fill' }));

    const [override] = await repo.activityLog({ types: ['RULE_OVERRIDE'] });
    assert.equal(override.payload.ruleStop, 110);
    assert.equal(override.payload.actualStop, 100, 'what the stop actually stayed at');
  });

  test('enrichment respects backdated ordering', async () => {
    const t = await openDell();
    await repo.appendEvent(t.id, E.stopChange(D(8), { to: 104 }));
    await repo.appendEvent(t.id, E.stopChange(D(6), { to: 99 })); // written later, happened first

    const log = await repo.activityLog({ types: ['STOP_CHANGE'] });
    assert.equal(log[0].payload.from, 99, 'the later move came from 99, not from 95');
    assert.equal(log[1].payload.from, 95);
  });
});

describe('trade metadata', () => {
  test('a broker trailing plan is stored per trade', async () => {
    const t = await openDell();
    await repo.setManagementPlan(t.id, {
      managementMode: 'trailing',
      trailType: 'TRAIL_PCT',
      trailValue: 8,
    });
    const saved = await repo.getTrade(t.id);
    assert.equal(saved.managementMode, 'trailing');
    assert.equal(saved.trailType, 'TRAIL_PCT');
    assert.equal(saved.trailValue, 8);
  });

  test('switching back to manual clears the trail', async () => {
    const t = await openDell();
    await repo.setManagementPlan(t.id, {
      managementMode: 'trailing',
      trailType: 'TRAIL_USD',
      trailValue: 7,
    });
    await repo.setManagementPlan(t.id, { managementMode: 'manual' });
    const saved = await repo.getTrade(t.id);
    assert.equal(saved.managementMode, 'manual');
    assert.equal(saved.trailType, null);
    assert.equal(saved.trailValue, null);
  });

  test('the stop rule survives a round trip through storage', async () => {
    const t = await repo.createTrade(
      { ticker: 'DELL', rule: 'ladderClassic' },
      E.open(D(3), { price: 100, qty: 100, stop: 95 })
    );
    assert.equal((await repo.getTrade(t.id)).rule, 'ladderClassic');
  });

  test('an OPEN without a rule does not wipe the one on the trade', async () => {
    const t = await repo.createTrade(
      { ticker: 'DELL', rule: 'trail1_5R' },
      E.open(D(3), { price: 100, qty: 100, stop: 95 }) // no rule in the payload
    );
    assert.equal((await repo.getTrade(t.id)).rule, 'trail1_5R');
  });

  test('a rule on the event wins over the trade default', async () => {
    const t = await repo.createTrade(
      { ticker: 'DELL', rule: 'trail1_5R' },
      E.open(D(3), { price: 100, qty: 100, stop: 95, rule: 'beAt1R' })
    );
    assert.equal((await repo.getTrade(t.id)).rule, 'beAt1R');
  });
});
