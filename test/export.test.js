import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../src/core/events.js';
import { MemoryStore } from '../src/data/store.js';
import { Repository } from '../src/data/repo.js';
import { aggregate } from '../src/core/stats.js';
import { tradeSummary } from '../src/core/metrics.js';
import { csvCell, toCsv, tradesCsv, eventsCsv, TRADE_HEADERS } from '../src/export/csv.js';
import { reviewMarkdown } from '../src/export/markdown.js';

const D = (d, h = 15) => `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:35:00Z`;

let repo;
beforeEach(() => {
  repo = new Repository(new MemoryStore());
});

async function seed() {
  const a = await repo.createTrade(
    { ticker: 'DELL', setup: 'Breakout', entryEmotion: 'Calm' },
    E.open(D(3), { price: 100, qty: 100, stop: 95 })
  );
  await repo.appendEvent(
    a.id,
    E.stopChange(D(5), { to: 100, reason: 'higher low, held', source: 'rule' })
  );
  await repo.appendEvent(
    a.id,
    E.ruleOverride(D(6), { ruleStop: 110, reason: 'holding for the gap fill' })
  );
  await repo.appendEvent(a.id, E.close(D(7), { price: 102, reason: 'Trailing stop' }));

  const b = await repo.createTrade(
    { ticker: 'JPM', setup: 'Pullback', entryEmotion: 'FOMO' },
    E.open(D(4), { price: 50, qty: 100, stop: 47 })
  );
  await repo.appendEvent(b.id, E.close(D(6), { price: 47, reason: 'Stop hit' }));

  await repo.createTrade({ ticker: 'NVDA', setup: 'Breakout' }, E.open(D(8), { price: 180, qty: 30, stop: 172 }));
  return { a, b };
}

describe('CSV quoting', () => {
  test('plain values pass through', () => {
    assert.equal(csvCell('DELL'), 'DELL');
    assert.equal(csvCell(1.25), '1.25');
  });

  test('null and undefined become empty', () => {
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });

  test('a comma in a note does not corrupt the row', () => {
    assert.equal(csvCell('held, then trimmed'), '"held, then trimmed"');
  });

  test('quotes are doubled', () => {
    assert.equal(csvCell('said "no"'), '"said ""no"""');
  });

  test('newlines are contained', () => {
    assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  });

  test('a quoted field keeps the row parseable', () => {
    const csv = toCsv(['a', 'b'], [['x, y', 'z']]);
    assert.equal(csv, 'a,b\n"x, y",z');
    assert.equal(csv.split('\n').length, 2, 'still two lines');
  });
});

describe('trades CSV', () => {
  test('one row per trade with a stable header', async () => {
    await seed();
    const csv = tradesCsv(await repo.listTrades());
    const lines = csv.split('\n');
    assert.equal(lines[0], TRADE_HEADERS.join(','));
    assert.equal(lines.length, 4, 'header plus three trades');
  });

  test('carries the numbers a spreadsheet needs', async () => {
    await seed();
    const csv = tradesCsv(await repo.listTrades());
    const dell = csv.split('\n').find((l) => l.includes('DELL'));
    const cols = dell.split(',');
    assert.equal(cols[TRADE_HEADERS.indexOf('R_dollars')], '500');
    assert.equal(cols[TRADE_HEADERS.indexOf('realized_R')], '0.4');
    assert.equal(cols[TRADE_HEADERS.indexOf('exit_reason')], 'Trailing stop');
    assert.equal(cols[TRADE_HEADERS.indexOf('rule_overrides')], '1');
  });

  test('open trades export with empty exit fields rather than zeroes', async () => {
    await seed();
    const nvda = tradesCsv(await repo.listTrades()).split('\n').find((l) => l.startsWith('t_') && l.includes('NVDA'));
    const cols = nvda.split(',');
    assert.equal(cols[TRADE_HEADERS.indexOf('status')], 'OPEN');
    assert.equal(cols[TRADE_HEADERS.indexOf('exit_price')], '');
    assert.equal(cols[TRADE_HEADERS.indexOf('realized_R')], '0');
  });

  test('missing market data leaves MFE blank, not zero', async () => {
    await seed();
    const dell = tradesCsv(await repo.listTrades()).split('\n').find((l) => l.includes('DELL'));
    assert.equal(dell.split(',')[TRADE_HEADERS.indexOf('mfe_R')], '');
  });
});

describe('events CSV', () => {
  test('every event becomes a row with its ticker', async () => {
    await seed();
    const csv = eventsCsv(await repo.activityLog());
    assert.equal(csv.split('\n').length, 8, 'header plus seven events');
    assert.match(csv, /RULE_OVERRIDE/);
    assert.match(csv, /"higher low, held"/, 'the comma in the reason is quoted');
  });
});

describe('review markdown', () => {
  async function buildReview(previousAgg = null) {
    const { } = await seed();
    const all = await repo.listTrades();
    const closed = all.filter((t) => t.status === 'CLOSED');
    const open = all.filter((t) => t.status === 'OPEN');
    return reviewMarkdown({
      period: { label: 'week of Aug 3–7', from: '2026-08-03', to: '2026-08-07' },
      trades: closed,
      openTrades: open,
      log: await repo.activityLog(),
      previous: previousAgg,
      equity: 50000,
    });
  }

  test('leads with the period and the units', async () => {
    const md = await buildReview();
    assert.match(md, /^# Trading review — week of Aug 3–7/);
    assert.match(md, /1R is the dollar risk locked in/);
    assert.match(md, /daily-bar resolution/);
  });

  test('reports the aggregates', async () => {
    const md = await buildReview();
    assert.match(md, /Trades: 2 \(1W \/ 1L\)/);
    assert.match(md, /Win rate: 50%/);
    assert.match(md, /Net: -0\.60R/);
    assert.match(md, /rule overrides: 1/);
  });

  test('one line per closed trade', async () => {
    const md = await buildReview();
    assert.match(md, /\*\*DELL\*\* Breakout · 2026-08-03→2026-08-07/);
    assert.match(md, /exit 102 \(Trailing stop\)/);
    assert.match(md, /\*\*JPM\*\* Pullback/);
  });

  test('open trades are listed separately, not mixed into the results', async () => {
    const md = await buildReview();
    assert.match(md, /## Still open at period end/);
    assert.match(md, /\*\*NVDA\*\* Breakout · opened 2026-08-08/);
  });

  test('the event log is included in readable prose, with skipped rules called out', async () => {
    const md = await buildReview();
    assert.match(md, /## Everything that happened/);
    assert.match(md, /stop 95 → 100 \(higher low, held\) \[by rule\]/);
    assert.match(md, /SKIPPED the stop rule, which said 110 — "holding for the gap fill"/);
  });

  test('breakdowns flag samples too small to read anything into', async () => {
    const md = await buildReview();
    assert.match(md, /### By setup/);
    assert.match(md, /\| Breakout \| 1 \|.*too small \|/);
  });

  test('comparison is included when a prior period exists, with a caveat', async () => {
    const prev = aggregate([
      { status: 'CLOSED', realizedR: 1, R: 500, mfeR: 2, mfeCaptured: 0.5, roundTrip: false },
      { status: 'CLOSED', realizedR: -1, R: 500, mfeR: 0.5, mfeCaptured: null, roundTrip: false },
    ]);
    const md = await buildReview(prev);
    assert.match(md, /## Versus the previous period/);
    assert.match(md, /Trades: 2 vs 2/);
    assert.match(md, /treat any difference as an observation rather than a trend/);
  });

  test('closes by naming what it is', async () => {
    const md = await buildReview();
    assert.match(md, /No interpretation has been applied/);
  });

  test('an empty period says so instead of rendering blanks', async () => {
    const md = reviewMarkdown({
      period: { label: 'week of Sep 1–5', from: '2026-09-01', to: '2026-09-05' },
      trades: [],
      equity: 50000,
    });
    assert.match(md, /_No trades closed in this period\._/);
    assert.match(md, /Trades: 0/);
    assert.match(md, /Profit factor: —/, 'a dash, not NaN or Infinity');
  });

  test('stays small enough to paste', async () => {
    const md = await buildReview();
    assert.ok(md.length < 6000, `review was ${md.length} chars`);
  });
});
