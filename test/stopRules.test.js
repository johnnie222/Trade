import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateStopRule,
  simulateRule,
  resolveRule,
  withTradeTrailing,
  RuleType,
  PRESETS,
} from '../src/core/stopRules.js';

const near = (a, b, msg, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${msg ?? ''} expected ${b}, got ${a}`);

// entry 100, stop 95, rps 5
const ctx = (highestClose, activeStop = 95, currentPrice = highestClose) => ({
  entryPrice: 100,
  riskPerShare: 5,
  activeStop,
  highestClose,
  currentPrice,
});

describe('LADDER rules', () => {
  const rule = PRESETS.ladderClassic;

  test('below the first trigger the rule says nothing', () => {
    const r = evaluateStopRule(rule, ctx(104));
    assert.equal(r.ruleStop, null);
    assert.equal(r.shouldRaise, false);
    near(r.target, 95, 'stop untouched');
  });

  test('a close at exactly 1R triggers breakeven', () => {
    const r = evaluateStopRule(rule, ctx(105));
    near(r.ruleStop, 100);
    assert.equal(r.shouldRaise, true);
    assert.equal(r.triggeredBy, '1R → 0R');
  });

  test('at 2R the rule moves to 1R', () => {
    const r = evaluateStopRule(rule, ctx(110));
    near(r.ruleStop, 105);
    assert.equal(r.triggeredBy, '2R → 1R');
  });

  test('the highest satisfied rung wins, not the first', () => {
    const r = evaluateStopRule(rule, ctx(118));
    near(r.ruleStop, 110, '3R rung -> stop at 2R');
  });

  test('triggers are evaluated on closes, so a wick alone does nothing', () => {
    // The high was 112 (2.4R) but the close was 104 (0.8R).
    const r = evaluateStopRule(rule, ctx(104));
    assert.equal(r.ruleStop, null, 'a wick is not a 2R trade');
  });

  test('rungs may be supplied out of order', () => {
    const messy = {
      type: RuleType.LADDER,
      rungs: [
        { triggerR: 3, stopR: 2 },
        { triggerR: 1, stopR: 0 },
        { triggerR: 2, stopR: 1 },
      ],
    };
    near(evaluateStopRule(messy, ctx(110)).ruleStop, 105);
  });
});

describe('trailing rules', () => {
  test('trail n R below the highest close', () => {
    near(evaluateStopRule(PRESETS.trail1_5R, ctx(120)).ruleStop, 112.5);
  });

  test('trail a percentage below the highest close', () => {
    near(evaluateStopRule(resolveRule('trailOnly', { trailType: 'TRAIL_PCT', trailValue: 8 }), ctx(120)).ruleStop, 110.4);
  });

  test('trail a dollar amount', () => {
    const rule = { type: RuleType.TRAIL_USD, usd: 7 };
    near(evaluateStopRule(rule, ctx(120)).ruleStop, 113);
  });
});

describe('ratchet and edge cases', () => {
  test('a rule never lowers an already-higher stop', () => {
    // Manual stop at 115; the trailing rule only justifies 112.5.
    const r = evaluateStopRule(PRESETS.trail1_5R, ctx(120, 115));
    near(r.ruleStop, 112.5, 'the rule still reports its own level');
    near(r.target, 115, 'but the target holds the higher stop');
    assert.equal(r.shouldRaise, false);
  });

  test('NONE and a missing rule are inert', () => {
    for (const rule of [null, undefined, { type: RuleType.NONE }]) {
      const r = evaluateStopRule(rule, ctx(130));
      assert.equal(r.shouldRaise, false);
      near(r.target, 95);
    }
  });

  test('no price history means no opinion', () => {
    const r = evaluateStopRule(PRESETS.ladderClassic, {
      entryPrice: 100,
      riskPerShare: 5,
      activeStop: 95,
      highestClose: null,
      currentPrice: null,
    });
    assert.equal(r.ruleStop, null);
  });

  test('a stop that has passed the current price is flagged as breached', () => {
    // Ran to 130, pulled back to 111; a 1.5R trail sits at 122.5.
    const r = evaluateStopRule(PRESETS.trail1_5R, ctx(130, 95, 111));
    assert.equal(r.breached, true, 'the rule says you should already be out');
  });
});

describe('counterfactual simulation', () => {
  const base = { entryPrice: 100, initialStop: 95, riskPerShare: 5 };
  const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });

  test('a rule that never triggers exits at the initial stop', () => {
    const bars = [
      bar('2026-08-03', 100, 102, 99, 101),
      bar('2026-08-04', 101, 101, 94, 96), // low breaches 95
    ];
    const r = simulateRule(PRESETS.ladderClassic, { ...base, bars });
    near(r.exitPrice, 95);
    assert.equal(r.exitReason, 'stop');
    near(r.resultR, -1);
  });

  test('a gap below the stop exits at the open, not the stop', () => {
    const bars = [
      bar('2026-08-03', 100, 102, 99, 101),
      bar('2026-08-04', 90, 92, 88, 89), // gapped straight through
    ];
    const r = simulateRule(PRESETS.ladderClassic, { ...base, bars });
    near(r.exitPrice, 90, 'you do not get filled at your stop on a gap');
    assert.equal(r.exitReason, 'gap');
    near(r.resultR, -2, 'a 1R stop produced a 2R loss');
  });

  test('the ladder protects a give-back', () => {
    const bars = [
      bar('2026-08-03', 100, 104, 99, 103),
      bar('2026-08-04', 103, 111, 102, 110), // closes at 2R -> stop to 105
      bar('2026-08-05', 110, 112, 104, 106), // low 104 takes the 105 stop
    ];
    const r = simulateRule(PRESETS.ladderClassic, { ...base, bars });
    near(r.exitPrice, 105);
    near(r.resultR, 1, 'the rule banked 1R');
    assert.equal(r.stopMoves, 1);
  });

  test("the stop is checked against the morning's level, not the evening's", () => {
    // Day 2 closes at 2R, which would raise the stop to 105 — but the same
    // day's low was 104. The stop only existed at 95 that morning, so the
    // trade survives. Applying the new stop retroactively would invent an exit.
    const bars = [
      bar('2026-08-03', 100, 104, 99, 103),
      bar('2026-08-04', 103, 111, 104, 110),
      bar('2026-08-05', 110, 115, 109, 114),
    ];
    const r = simulateRule(PRESETS.ladderClassic, { ...base, bars });
    assert.equal(r.exitReason, 'still open');
    near(r.exitPrice, 114);
  });

  test('a trailing rule rides and then exits', () => {
    const bars = [
      bar('2026-08-03', 100, 106, 99, 105),
      bar('2026-08-04', 105, 121, 105, 120), // stop -> 112.5
      bar('2026-08-05', 120, 122, 111, 113), // low 111 takes it
    ];
    const r = simulateRule(PRESETS.trail1_5R, { ...base, bars });
    near(r.exitPrice, 112.5);
    near(r.resultR, 2.5);
  });

  test('an unfinished trade marks itself still open', () => {
    const bars = [bar('2026-08-03', 100, 108, 99, 107)];
    const r = simulateRule(PRESETS.ladderClassic, { ...base, bars });
    assert.equal(r.exitReason, 'still open');
    assert.equal(r.estimated, true);
  });

  test('no bars means no simulation', () => {
    assert.equal(simulateRule(PRESETS.ladderClassic, { ...base, bars: [] }), null);
  });
});

describe('configurable trail values', () => {
  test('a percent trail reads its number from settings', () => {
    const r = resolveRule('trailOnly', { trailType: RuleType.TRAIL_PCT, trailValue: 12 });
    near(evaluateStopRule(r, ctx(120)).ruleStop, 105.6);
    assert.match(r.label, /Trail 12% from the start/);
  });

  test('a dollar trail', () => {
    const r = resolveRule('trailOnly', { trailType: RuleType.TRAIL_USD, trailValue: 7 });
    near(evaluateStopRule(r, ctx(120)).ruleStop, 113);
  });

  test('an R trail', () => {
    const r = resolveRule('trailOnly', { trailType: RuleType.TRAIL_R, trailValue: 2 });
    near(evaluateStopRule(r, ctx(120)).ruleStop, 110);
  });

  test('presets without a trailing leg ignore the settings', () => {
    assert.equal(resolveRule('ladderClassic', { trailValue: 99 }), PRESETS.ladderClassic);
  });

  test('an unknown key falls back to discretionary rather than throwing', () => {
    assert.equal(resolveRule('nonsense', {}).type, RuleType.NONE);
  });
});

describe('ladder handing off to a trail', () => {
  const rule = () => resolveRule('ladderThenTrail', { trailType: RuleType.TRAIL_PCT, trailValue: 10 });

  test('below the last rung the ladder alone applies', () => {
    // 1.2R: past the 1R rung, short of the 2R rung, so no handoff yet.
    const r = evaluateStopRule(rule(), ctx(106));
    near(r.ruleStop, 100, 'breakeven from the 1R rung');
    assert.equal(r.triggeredBy, '1R → 0R');
  });

  test('at the last rung the ladder still wins while the trail sits lower', () => {
    // 2R close of 110: ladder says 105, a 10% trail says 99.
    const r = evaluateStopRule(rule(), ctx(110));
    near(r.ruleStop, 105, 'the higher of the two');
    assert.equal(r.triggeredBy, '2R → 1R');
  });

  test('past the last rung the trail takes over', () => {
    // 140 is 8R. The ladder is stuck at 105; a 10% trail is at 126.
    const r = evaluateStopRule(rule(), ctx(140));
    near(r.ruleStop, 126);
    assert.match(r.triggeredBy, /trail 10%/);
  });

  test('the handoff can never lower the stop the ladder earned', () => {
    const tight = resolveRule('ladderThenTrail', { trailType: RuleType.TRAIL_PCT, trailValue: 40 });
    const r = evaluateStopRule(tight, ctx(115));
    near(r.ruleStop, 105, 'a 40% trail sits far below the 1R rung, so the rung holds');
  });

  test('a ladder with no trailing leg simply stops moving', () => {
    const r = evaluateStopRule(PRESETS.ladderClassic, ctx(200));
    near(r.ruleStop, 110, 'the 3R rung is the end of it');
  });

  test('the handoff survives the counterfactual simulator', () => {
    const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
    const bars = [
      bar('2026-08-03', 100, 112, 99, 111), // 2.2R -> ladder to 105
      bar('2026-08-04', 111, 141, 110, 140), // 8R -> trail to 126
      bar('2026-08-05', 140, 142, 125, 127), // low 125 takes the 126 stop
    ];
    const r = simulateRule(rule(), { entryPrice: 100, initialStop: 95, riskPerShare: 5, bars });
    near(r.exitPrice, 126);
    near(r.resultR, 5.2, 'the trail banked far more than the ladder would have');
  });
});

describe('per-trade trailing after 3R', () => {
  test('does not start before 3R', () => {
    const rule = withTradeTrailing(PRESETS.ladderClassic, {
      trailType: RuleType.TRAIL_PCT,
      trailValue: 10,
    });
    near(evaluateStopRule(rule, ctx(114)).ruleStop, 105);
  });

  test('keeps a hard 2R floor at activation', () => {
    const rule = withTradeTrailing(PRESETS.ladderClassic, {
      trailType: RuleType.TRAIL_PCT,
      trailValue: 10,
    });
    near(evaluateStopRule(rule, ctx(115)).ruleStop, 110);
  });

  test('the trail takes over above the floor and supports dollars', () => {
    const pctRule = withTradeTrailing(PRESETS.ladderClassic, {
      trailType: RuleType.TRAIL_PCT,
      trailValue: 10,
    });
    near(evaluateStopRule(pctRule, ctx(130)).ruleStop, 117);

    const usdRule = withTradeTrailing(PRESETS.ladderClassic, {
      trailType: RuleType.TRAIL_USD,
      trailValue: 7,
    });
    near(evaluateStopRule(usdRule, ctx(130)).ruleStop, 123);
  });
});
