import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../src/core/events.js';
import {
  projectTrade,
  currentR,
  realizedR,
  priceAtR,
  openRisk,
  lockedIn,
  isProtected,
  portfolioRisk,
  tradeStatusLabel,
  TradeStatus,
} from '../src/core/engine.js';

const near = (a, b, msg, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${msg ?? ''} expected ${b}, got ${a}`);

const D = (n) => `2026-08-${String(n).padStart(2, '0')}T14:30:00Z`;

/** entry 100, stop 95, 100 shares -> rps 5, R $500 */
const basic = () => [E.open(D(3), { price: 100, qty: 100, stop: 95 })];

describe('R engine — the locked unit', () => {
  test('R is risk per share times initial size, in dollars', () => {
    const s = projectTrade(basic());
    near(s.riskPerShare, 5, 'risk/share');
    near(s.R, 500, 'R');
  });

  test('target prices', () => {
    const s = projectTrade(basic());
    near(priceAtR(s, 1), 105);
    near(priceAtR(s, 2), 110);
    near(priceAtR(s, 3), 115);
  });

  test('with no adds or trims, R reduces to the simple price ratio', () => {
    const s = projectTrade(basic());
    for (const px of [90, 95, 100, 105, 110, 137.5]) {
      near(currentR(s, px), (px - 100) / 5, `at ${px}`);
    }
  });

  test('a stop below entry is required', () => {
    assert.throws(() => projectTrade([E.open(D(3), { price: 100, qty: 10, stop: 100 })]));
    assert.throws(() => projectTrade([E.open(D(3), { price: 100, qty: 10, stop: 105 })]));
  });

  test('raising the stop does not change R', () => {
    const s = projectTrade([...basic(), E.stopChange(D(6), { to: 104 })]);
    near(s.R, 500, 'R after stop raise');
    near(s.initialStop, 95, 'initial stop is immutable');
    near(s.activeStop, 104);
    near(currentR(s, 110), 2, 'R still measured from the original risk');
  });
});

describe('R engine — adds', () => {
  test('weighted average cost moves, R does not', () => {
    // 100 @ 100, then 50 @ 110 -> avg (10000 + 5500) / 150
    const s = projectTrade([...basic(), E.add(D(5), { price: 110, qty: 50 })]);
    near(s.qty, 150);
    near(s.avgCost, 15500 / 150);
    near(s.R, 500, 'R unchanged by the add');
    near(s.riskPerShare, 5);
  });

  test('current R after an add uses total P&L over the original R', () => {
    const s = projectTrade([...basic(), E.add(D(5), { price: 110, qty: 50 })]);
    const avg = 15500 / 150;
    near(currentR(s, 120), (150 * (120 - avg)) / 500);
  });
});

describe('R engine — trims and closing', () => {
  test('a trim realizes against average cost', () => {
    const s = projectTrade([...basic(), E.trim(D(7), { price: 105, qty: 50 })]);
    near(s.realizedPnl, 50 * 5, 'realized $250');
    near(realizedR(s), 0.5);
    near(s.qty, 50);
    near(s.avgCost, 100, 'avg cost is untouched by a trim');
  });

  test('realized plus open sums to current R', () => {
    const s = projectTrade([...basic(), E.trim(D(7), { price: 105, qty: 50 })]);
    // realized 250, open 50 * (110-100) = 500 -> 750 / 500 = 1.5R
    near(currentR(s, 110), 1.5);
  });

  test('trimming the whole position closes the trade', () => {
    const s = projectTrade([...basic(), E.trim(D(7), { price: 105, qty: 100 })]);
    assert.equal(s.status, TradeStatus.CLOSED);
    near(realizedR(s), 1);
  });

  test('cannot trim more than is open', () => {
    assert.throws(() => projectTrade([...basic(), E.trim(D(7), { price: 105, qty: 101 })]));
  });

  test('close realizes the remainder', () => {
    const s = projectTrade([
      ...basic(),
      E.trim(D(7), { price: 110, qty: 50 }),
      E.close(D(9), { price: 108, reason: 'structure broken' }),
    ]);
    // 50 * 10 = 500, then 50 * 8 = 400 -> 900 / 500 = 1.8R
    near(realizedR(s), 1.8);
    assert.equal(s.status, TradeStatus.CLOSED);
    assert.equal(s.exitReason, 'structure broken');
  });

  test('a closed trade rejects further activity', () => {
    const closed = [...basic(), E.close(D(9), { price: 108 })];
    assert.throws(() => projectTrade([...closed, E.add(D(10), { price: 108, qty: 10 })]));
    assert.throws(() => projectTrade([...closed, E.close(D(10), { price: 108 })]));
  });
});

describe('R engine — splits', () => {
  test('a 2:1 split halves prices, doubles shares, and leaves R untouched', () => {
    const s = projectTrade([...basic(), E.split(D(8), { numerator: 2, denominator: 1 })]);
    near(s.entryPrice, 50);
    near(s.initialStop, 47.5);
    near(s.avgCost, 50);
    near(s.activeStop, 47.5);
    near(s.riskPerShare, 2.5);
    near(s.qty, 200);
    near(s.initialQty, 200);
    near(s.R, 500, 'R survives the split');
  });

  test('R is identical across the split for the same economic outcome', () => {
    const noSplit = projectTrade([...basic()]);
    const withSplit = projectTrade([...basic(), E.split(D(8), { numerator: 2, denominator: 1 })]);
    near(currentR(noSplit, 110), currentR(withSplit, 55), 'same trade, same R');
  });

  test('a reverse split works the same way', () => {
    const s = projectTrade([...basic(), E.split(D(8), { numerator: 1, denominator: 10 })]);
    near(s.entryPrice, 1000);
    near(s.qty, 10);
    near(s.R, 500);
  });

  test('stop history is restated into post-split prices', () => {
    const s = projectTrade([
      ...basic(),
      E.stopChange(D(6), { to: 104 }),
      E.split(D(8), { numerator: 2, denominator: 1 }),
    ]);
    near(s.stopHistory[0].to, 47.5, 'initial stop restated');
    near(s.stopHistory[1].to, 52, 'raised stop restated');
  });

  test('a split after a partial exit does not disturb realized dollars', () => {
    const s = projectTrade([
      ...basic(),
      E.trim(D(7), { price: 105, qty: 50 }),
      E.split(D(8), { numerator: 2, denominator: 1 }),
    ]);
    near(s.realizedPnl, 250, 'already-realized dollars are dollars');
    near(s.qty, 100);
    near(s.R, 500);
  });
});

describe('R engine — risk', () => {
  test('open risk from average cost to the active stop', () => {
    const s = projectTrade(basic());
    near(openRisk(s), 500);
  });

  test('open risk is zero once the stop clears cost', () => {
    const s = projectTrade([...basic(), E.stopChange(D(6), { to: 100 })]);
    near(openRisk(s), 0);
    assert.equal(isProtected(s), true);
    near(lockedIn(s), 0, 'breakeven stop locks in nothing');
  });

  test('locked-in dollars above breakeven', () => {
    const s = projectTrade([...basic(), E.stopChange(D(6), { to: 104 })]);
    near(lockedIn(s), 400);
  });

  test('a trim reduces open risk proportionally', () => {
    const s = projectTrade([...basic(), E.trim(D(7), { price: 105, qty: 50 })]);
    near(openRisk(s), 250);
  });

  test('portfolio risk sums open positions', () => {
    const a = projectTrade(basic(), { ticker: 'AAA' });
    const b = projectTrade([E.open(D(4), { price: 50, qty: 100, stop: 47 })], { ticker: 'BBB' });
    const c = projectTrade([...basic(), E.close(D(9), { price: 120 })], { ticker: 'CCC' });
    const p = portfolioRisk([a, b, c]);
    near(p.total, 800);
    assert.equal(p.count, 2, 'closed trades carry no risk');
    near(p.largest, 500);
  });

  test('a widened stop is recorded rather than rejected', () => {
    const s = projectTrade([
      ...basic(),
      E.stopChange(D(6), { to: 104 }),
      E.stopChange(D(7), { to: 98, reason: 'giving it room' }),
    ]);
    assert.equal(s.stopWidenings, 1);
    assert.equal(s.stopHistory.at(-1).widened, true);
    near(s.activeStop, 98);
  });
});

describe('R engine — status labels', () => {
  const s = projectTrade(basic());
  test('near stop', () => assert.equal(tradeStatusLabel(s, 96), 'Near Stop'));
  test('open', () => assert.equal(tradeStatusLabel(s, 102), 'Open'));
  test('at 1R', () => assert.equal(tradeStatusLabel(s, 106), 'At 1R'));
  test('at 2R', () => assert.equal(tradeStatusLabel(s, 111), 'At 2R'));
});
