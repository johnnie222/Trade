import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../src/core/events.js';
import { projectTrade } from '../src/core/engine.js';
import { excursions, mfeCaptured, isRoundTrip, tradeSummary } from '../src/core/metrics.js';

const near = (a, b, msg, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${msg ?? ''} expected ${b}, got ${a}`);

const bar = (d, o, h, l, c) => ({ date: `2026-08-${d}`, open: o, high: h, low: l, close: c });

// entry 100, stop 95, rps 5
const BARS = [
  bar('03', 100, 104, 98, 103),
  bar('04', 103, 114, 102, 112), // high 114 -> 2.8R
  bar('05', 112, 113, 97, 99), // low 97 -> -0.6R
  bar('06', 99, 106, 99, 105),
];

const openEv = E.open('2026-08-03T14:30:00Z', { price: 100, qty: 100, stop: 95 });

describe('MFE and MAE', () => {
  test('measured in price terms against the original entry', () => {
    const s = projectTrade([openEv, E.close('2026-08-06T20:00:00Z', { price: 105 })]);
    const exc = excursions(s, BARS);
    near(exc.mfeR, 2.8, 'MFE');
    near(exc.maeR, -0.6, 'MAE');
    assert.equal(exc.resolution, 'daily');
  });

  test('adds and trims do not move them — they measure what was on offer', () => {
    const plain = projectTrade([openEv, E.close('2026-08-06T20:00:00Z', { price: 105 })]);
    const managed = projectTrade([
      openEv,
      E.add('2026-08-04T15:00:00Z', { price: 110, qty: 100 }),
      E.trim('2026-08-05T15:00:00Z', { price: 108, qty: 150 }),
      E.close('2026-08-06T20:00:00Z', { price: 105 }),
    ]);
    near(excursions(managed, BARS).mfeR, excursions(plain, BARS).mfeR);
  });

  test('an open trade measures to the last available bar', () => {
    const s = projectTrade([openEv]);
    const exc = excursions(s, BARS);
    near(exc.mfeR, 2.8);
    assert.equal(exc.bars, 4);
  });

  test('bars outside the holding period are excluded', () => {
    const s = projectTrade([openEv, E.close('2026-08-04T20:00:00Z', { price: 112 })]);
    const exc = excursions(s, BARS);
    near(exc.mfeR, 2.8);
    near(exc.maeR, -0.4, 'the day-5 low of 97 is after the exit');
    assert.equal(exc.bars, 2);
  });

  test('no overlapping bars yields null rather than a wrong number', () => {
    assert.equal(excursions(projectTrade([openEv]), []), null);
  });
});

describe('capture', () => {
  test('realized over available', () => {
    const s = projectTrade([openEv, E.close('2026-08-06T20:00:00Z', { price: 107 })]);
    // realized 1.4R against an MFE of 2.8R
    near(mfeCaptured(s, excursions(s, BARS)), 0.5);
  });

  test('null when the move was too small to talk about capturing', () => {
    // High of 100.5 is 0.1R. A ratio against that denominator is noise.
    const bars = [bar('03', 100, 100.5, 94, 95)];
    const s = projectTrade([openEv, E.close('2026-08-03T20:00:00Z', { price: 95 })]);
    assert.equal(mfeCaptured(s, excursions(s, bars)), null);
  });

  test('null when the trade never went green at all', () => {
    const bars = [bar('03', 100, 100, 94, 95)];
    const s = projectTrade([openEv, E.close('2026-08-03T20:00:00Z', { price: 95 })]);
    assert.equal(mfeCaptured(s, excursions(s, bars)), null);
  });

  test('negative capture is kept, not clamped', () => {
    // 2.8R was on the table and the trade still closed red.
    const s = projectTrade([openEv, E.close('2026-08-06T20:00:00Z', { price: 98 })]);
    near(mfeCaptured(s, excursions(s, BARS)), -0.4 / 2.8);
  });
});

describe('round trip', () => {
  test('a big move given back is flagged', () => {
    // MFE 2.8R, realized 0.4R -> 0.4 <= 0.35 * 2.8
    const s = projectTrade([openEv, E.close('2026-08-06T20:00:00Z', { price: 102 })]);
    assert.equal(isRoundTrip(s, excursions(s, BARS)), true);
  });

  test('a big move mostly kept is not', () => {
    const s = projectTrade([openEv, E.close('2026-08-04T20:00:00Z', { price: 112 })]);
    assert.equal(isRoundTrip(s, excursions(s, BARS)), false);
  });

  test('a small move given back is not — nothing was there to protect', () => {
    const bars = [bar('03', 100, 105, 99, 104), bar('04', 104, 105, 99, 100)];
    const s = projectTrade([openEv, E.close('2026-08-04T20:00:00Z', { price: 100 })]);
    const exc = excursions(s, bars);
    near(exc.mfeR, 1, 'MFE only 1R');
    assert.equal(isRoundTrip(s, exc), false);
  });

  test('open trades are never flagged', () => {
    const s = projectTrade([openEv]);
    assert.equal(isRoundTrip(s, excursions(s, BARS)), false);
  });
});

describe('trade summary', () => {
  test('collects everything a review needs', () => {
    const s = projectTrade(
      [
        openEv,
        E.stopChange('2026-08-04T15:00:00Z', { to: 100, source: 'rule' }),
        E.ruleOverride('2026-08-05T15:00:00Z', { ruleStop: 105, reason: 'gap fill' }),
        E.close('2026-08-06T20:00:00Z', { price: 102, reason: 'trailing stop' }),
      ],
      { id: 't1', ticker: 'DELL', setup: 'Breakout', entryEmotion: 'Calm' }
    );
    const sum = tradeSummary(s, BARS);
    assert.equal(sum.ticker, 'DELL');
    near(sum.realizedR, 0.4);
    near(sum.mfeR, 2.8);
    assert.equal(sum.roundTrip, true);
    assert.equal(sum.stopChanges, 1);
    assert.equal(sum.ruleOverrides, 1);
    assert.equal(sum.entryEmotion, 'Calm');
    assert.equal(sum.exitReason, 'trailing stop');
    assert.equal(sum.holdingDays, 3);
  });

  test('works with no market data at all', () => {
    const s = projectTrade([openEv, E.close('2026-08-06T20:00:00Z', { price: 108 })], {
      ticker: 'JPM',
    });
    const sum = tradeSummary(s);
    near(sum.realizedR, 1.6);
    assert.equal(sum.mfeR, null, 'absent, not guessed');
    assert.equal(sum.roundTrip, false);
  });
});
