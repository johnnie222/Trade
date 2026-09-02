import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregate,
  bySetup,
  byMonth,
  byWeek,
  byEmotion,
  compare,
  dashboard,
  inPeriod,
  marketDate,
  monthKey,
  weekKey,
  MIN_SAMPLE,
} from '../src/core/stats.js';

const near = (a, b, msg, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${msg ?? ''} expected ${b}, got ${a}`);

/** Minimal trade summary. R defaults to $500 so R multiples map to dollars. */
const t = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  ticker: 'AAA',
  status: 'CLOSED',
  setup: 'Breakout',
  entryEmotion: 'Calm',
  exitReason: 'Target',
  openedAt: '2026-08-03T13:35:00Z',
  closedAt: '2026-08-07T19:55:00Z',
  R: 500,
  realizedR: 1,
  mfeR: 2,
  maeR: -0.3,
  mfeCaptured: 0.5,
  roundTrip: false,
  stopChanges: 1,
  stopWidenings: 0,
  ruleOverrides: 0,
  holdingDays: 4,
  ...over,
});

describe('winners, losers and scratches', () => {
  const rows = [
    t({ realizedR: 2 }),
    t({ realizedR: 1 }),
    t({ realizedR: -1 }),
    t({ realizedR: -0.5 }),
    t({ realizedR: 0 }),
  ];

  test('counts', () => {
    const s = aggregate(rows);
    assert.equal(s.trades, 5);
    assert.equal(s.winners, 2);
    assert.equal(s.losers, 2);
    assert.equal(s.scratches, 1, 'a flat exit is neither');
  });

  test('win rate excludes scratches from the denominator', () => {
    near(aggregate(rows).winRate, 0.5, '2 of 4 decided trades, not 2 of 5');
  });

  test('gross profit and loss', () => {
    const s = aggregate(rows);
    near(s.grossProfitR, 3);
    near(s.grossLossR, 1.5);
    near(s.netR, 1.5);
    near(s.netPnl, 750, 'R multiples times the dollar R');
  });

  test('averages', () => {
    const s = aggregate(rows);
    near(s.avgWinnerR, 1.5);
    near(s.avgLoserR, -0.75);
    near(s.avgWinner, 750);
    near(s.avgLoser, -375);
    near(s.expectancy, 0.3, 'net over all trades including the scratch');
  });

  test('profit factor', () => {
    near(aggregate(rows).profitFactor, 2);
  });

  test('largest winner and loser', () => {
    const s = aggregate(rows);
    near(s.largestWinnerR, 2);
    near(s.largestLoserR, -1);
  });
});

describe('refusing to invent numbers', () => {
  test('an empty period yields nulls, not NaN', () => {
    const s = aggregate([]);
    assert.equal(s.trades, 0);
    assert.equal(s.winRate, null);
    assert.equal(s.expectancy, null);
    assert.equal(s.profitFactor, null);
    assert.equal(s.avgWinnerR, null);
    near(s.netR, 0);
  });

  test('profit factor is null with no losers, not Infinity', () => {
    const s = aggregate([t({ realizedR: 1 }), t({ realizedR: 2 })]);
    assert.equal(s.profitFactor, null);
    assert.equal(s.winRate, 1);
  });

  test('profit factor is zero with no winners', () => {
    near(aggregate([t({ realizedR: -1 })]).profitFactor, 0);
  });

  test('open trades are excluded from realized statistics', () => {
    const s = aggregate([t({ realizedR: 1 }), t({ status: 'OPEN', closedAt: null, realizedR: 0 })]);
    assert.equal(s.trades, 1);
  });

  test('market-data metrics report how many trades they cover', () => {
    const s = aggregate([
      t({ mfeR: 2 }),
      t({ mfeR: null, maeR: null, mfeCaptured: null }),
      t({ mfeR: null, maeR: null, mfeCaptured: null }),
    ]);
    assert.equal(s.trades, 3);
    assert.equal(s.withMarketData, 1, 'so the UI can say 1 of 3');
    near(s.avgMfeR, 2, 'averaged over what exists, not over zeroes');
  });

  test('sample size is flagged rather than hidden', () => {
    assert.equal(aggregate([t(), t()]).reliable, false);
    assert.equal(aggregate(Array.from({ length: MIN_SAMPLE }, () => t())).reliable, true);
  });
});

describe('capture', () => {
  test('aggregate capture weights by the size of the move offered', () => {
    // 3R offered / 3R realized, and 0.3R offered / 0.3R realized.
    const rows = [
      t({ realizedR: 1.5, mfeR: 3, mfeCaptured: 0.5 }),
      t({ realizedR: 0.3, mfeR: 0.3, mfeCaptured: 1 }),
    ];
    const s = aggregate(rows);
    near(s.mfeCaptured, 1.8 / 3.3, 'total realized over total available');
    near(s.avgTradeCapture, 0.75, 'the plain mean of the two ratios');
  });

  test('the two diverge exactly where the naive mean would mislead', () => {
    const s = aggregate([
      t({ realizedR: 0.2, mfeR: 4, mfeCaptured: 0.05 }),
      t({ realizedR: 0.3, mfeR: 0.3, mfeCaptured: 1 }),
    ]);
    assert.ok(s.mfeCaptured < 0.2, 'most of the available move was missed');
    assert.ok(s.avgTradeCapture > 0.5, 'the plain mean says the opposite');
  });
});

describe('trade management counts', () => {
  const rows = [
    t({ mfeR: 2.8, realizedR: 0.2, roundTrip: true }),
    t({ mfeR: 3.2, realizedR: -1 }),
    t({ mfeR: 1.4, realizedR: 1.1 }),
    t({ mfeR: 0.6, realizedR: -1 }),
  ];

  test('trades that reached each multiple', () => {
    const s = aggregate(rows);
    assert.equal(s.reached1R, 3);
    assert.equal(s.reached2R, 2);
    assert.equal(s.reached3R, 1);
  });

  test('winners turned into losers', () => {
    const s = aggregate(rows);
    assert.equal(s.oneRToLoss, 1);
    assert.equal(s.twoRToLoss, 1);
  });

  test('round trips and stop behaviour are totalled', () => {
    const s = aggregate([
      ...rows,
      t({ stopChanges: 3, stopWidenings: 1, ruleOverrides: 2 }),
    ]);
    assert.equal(s.roundTrips, 1);
    assert.equal(s.stopWidenings, 1);
    assert.equal(s.ruleOverrides, 2);
  });
});

describe('market-time period keys', () => {
  test('an Israeli evening fill stays on the same US trading day', () => {
    // 22:30 in Israel on Monday the 24th is 15:30 in New York, same day.
    const iso = '2026-08-24T19:30:00Z';
    assert.equal(marketDate(iso), '2026-08-24');
    assert.equal(weekKey(iso), '2026-08-24', 'Monday of that week');
  });

  test('a fill after the New York midnight rolls over correctly', () => {
    assert.equal(marketDate('2026-08-25T03:00:00Z'), '2026-08-24', '11pm Monday in NY');
  });

  test('Friday belongs to the same week as Monday', () => {
    assert.equal(weekKey('2026-08-28T19:00:00Z'), '2026-08-24');
  });

  test('the following Monday starts a new week', () => {
    assert.equal(weekKey('2026-08-31T19:00:00Z'), '2026-08-31');
  });

  test('month keys use market time too', () => {
    assert.equal(monthKey('2026-09-01T03:00:00Z'), '2026-08', 'still August in New York');
  });
});

describe('breakdowns', () => {
  const rows = [
    t({ setup: 'Breakout', realizedR: 1 }),
    t({ setup: 'Breakout', realizedR: 2 }),
    t({ setup: 'Pullback', realizedR: -1 }),
    t({ setup: null, realizedR: 0.5 }),
  ];

  test('by setup, ordered by frequency and not by result', () => {
    const g = bySetup(rows);
    assert.deepEqual(g.map((x) => x.key), ['Breakout', 'Pullback', '—']);
    near(g[0].netR, 3);
    assert.equal(g[0].reliable, false, 'two trades is not a finding');
  });

  test('untagged trades are grouped, not dropped', () => {
    assert.equal(bySetup(rows).find((g) => g.key === '—').trades, 1);
  });

  test('by emotion', () => {
    const g = byEmotion([t({ entryEmotion: 'FOMO', realizedR: -1 }), t({ realizedR: 2 })]);
    assert.equal(g.length, 2);
    near(g.find((x) => x.key === 'FOMO').netR, -1);
  });

  test('by month, chronological', () => {
    const g = byMonth([
      t({ closedAt: '2026-07-15T19:00:00Z', realizedR: 1 }),
      t({ closedAt: '2026-08-07T19:00:00Z', realizedR: 2 }),
      t({ closedAt: '2026-08-20T19:00:00Z', realizedR: -1 }),
    ]);
    assert.deepEqual(g.map((x) => x.key), ['2026-07', '2026-08']);
    assert.equal(g[1].trades, 2);
    near(g[1].netR, 1);
    assert.equal(g[1].label, 'August 2026');
  });

  test('by week, with a readable label', () => {
    const g = byWeek([t({ closedAt: '2026-08-26T19:00:00Z', realizedR: 1 })]);
    assert.equal(g[0].key, '2026-08-24');
    assert.equal(g[0].label, 'Aug 24–28');
  });

  test('open trades are excluded from period grouping', () => {
    assert.equal(byMonth([t({ status: 'OPEN', closedAt: null })]).length, 0);
  });
});

describe('period comparison', () => {
  const many = (n, over) => Array.from({ length: n }, () => t(over));

  test('deltas and direction', () => {
    const now = aggregate(many(6, { realizedR: 1 }));
    const before = aggregate(many(6, { realizedR: 0.5 }));
    const c = compare(now, before);
    near(c.netR.delta, 3);
    assert.equal(c.netR.direction, 'better');
    near(c.netR.pctChange, 1);
  });

  test('for metrics where less is better, down is an improvement', () => {
    const now = aggregate([...many(5, { realizedR: 1 }), t({ roundTrip: true, realizedR: 0.1 })]);
    const before = aggregate([
      ...many(4, { realizedR: 1 }),
      ...many(3, { roundTrip: true, realizedR: 0.1 }),
    ]);
    assert.equal(compare(now, before).roundTrips.direction, 'better');
  });

  test('no direction is claimed from a small sample', () => {
    const c = compare(aggregate(many(3, { realizedR: 2 })), aggregate(many(3, { realizedR: 0 })));
    assert.equal(c.netR.direction, null, 'three trades supports no arrow');
    near(c.netR.delta, 6, 'the delta is still reported');
  });

  test('no direction when a metric is missing on either side', () => {
    const now = aggregate(many(6, { realizedR: 1 })); // no losers -> profitFactor null
    const before = aggregate([...many(5, { realizedR: 1 }), t({ realizedR: -1 })]);
    assert.equal(now.profitFactor, null);
    assert.equal(compare(now, before).profitFactor.direction, null);
  });

  test('comparing against nothing is safe', () => {
    const c = compare(aggregate(many(6)), null);
    assert.equal(c.netR.previous, null);
    assert.equal(c.netR.direction, null);
  });
});

describe('period selection', () => {
  const rows = [
    t({ closedAt: '2026-08-20T19:00:00Z' }),
    t({ closedAt: '2026-08-25T19:00:00Z' }),
    t({ closedAt: '2026-08-28T19:00:00Z' }),
  ];

  test('inclusive on both ends, in market dates', () => {
    assert.equal(inPeriod(rows, { from: '2026-08-24', to: '2026-08-28' }).length, 2);
    assert.equal(inPeriod(rows, { from: '2026-08-20', to: '2026-08-20' }).length, 1);
  });

  test('open ends', () => {
    assert.equal(inPeriod(rows, { from: '2026-08-25' }).length, 2);
    assert.equal(inPeriod(rows, { to: '2026-08-20' }).length, 1);
  });
});

describe('dashboard', () => {
  const rows = [
    t({ closedAt: '2026-07-10T19:00:00Z', realizedR: 1, setup: 'Breakout' }),
    t({ closedAt: '2026-07-20T19:00:00Z', realizedR: -1, setup: 'Pullback' }),
    t({ closedAt: '2026-08-05T19:00:00Z', realizedR: 2, setup: 'Breakout' }),
    t({ closedAt: '2026-08-12T19:00:00Z', realizedR: 1.5, setup: 'Breakout' }),
    t({ closedAt: '2026-08-19T19:00:00Z', realizedR: -0.5, setup: 'Pullback' }),
    t({ status: 'OPEN', closedAt: null, ticker: 'NVDA' }),
  ];

  test('assembles every panel in one call', () => {
    const d = dashboard(rows, { equity: 50000, openTrades: [{ ticker: 'NVDA' }] });

    assert.equal(d.allTime.trades, 5);
    near(d.allTime.netR, 3);

    assert.equal(d.thisMonth.key, '2026-08');
    assert.equal(d.thisMonth.trades, 3);
    assert.equal(d.lastMonth.key, '2026-07');

    assert.equal(d.months.length, 2);
    assert.equal(d.setups.length, 2);
    assert.equal(d.open.count, 1);
    assert.deepEqual(d.open.tickers, ['NVDA']);
  });

  test('month over month is present but claims no direction on small samples', () => {
    const d = dashboard(rows, { equity: 50000 });
    near(d.monthOverMonth.netR.current, 3);
    near(d.monthOverMonth.netR.previous, 0);
    assert.equal(d.monthOverMonth.netR.direction, null);
  });

  test('average risk as a percentage of equity', () => {
    const d = dashboard(rows, { equity: 50000 });
    near(d.allTime.avgRiskPct, 0.01, '$500 risk on $50k');
  });

  test('a brand new journal does not throw', () => {
    const d = dashboard([], { equity: 50000 });
    assert.equal(d.allTime.trades, 0);
    assert.equal(d.thisMonth, null);
    assert.equal(d.monthOverMonth, null);
    assert.deepEqual(d.months, []);
  });
});
