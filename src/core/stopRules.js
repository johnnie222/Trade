/**
 * Stop rules.
 *
 * A rule is a policy the trader declares in advance. This module never mutates
 * anything and never notifies. It answers one question — "given the bars so
 * far, where does your own rule put the stop?" — and the UI shows the gap.
 *
 * TRIGGERS USE CLOSES, NOT HIGHS.
 * A wick to 2R that closes at 1.2R is not a 2R trade. Triggering on highs makes
 * every rule fire on noise. MFE deliberately uses highs instead (metrics.js):
 * different question, different bar field.
 */

import { EPS } from './money.js';

export const RuleType = {
  NONE: 'NONE',
  LADDER: 'LADDER',
  TRAIL_R: 'TRAIL_R',
  TRAIL_PCT: 'TRAIL_PCT',
  TRAIL_USD: 'TRAIL_USD',
};

/** Presets. Defined once in Settings; picked from a dropdown at open. */
export const PRESETS = {
  discretionary: { type: RuleType.NONE, label: 'Discretionary' },
  beAt1R: {
    type: RuleType.LADDER,
    label: 'Breakeven at 1R',
    rungs: [{ triggerR: 1, stopR: 0 }],
  },
  ladderClassic: {
    type: RuleType.LADDER,
    label: '1R→BE, 2R→1R, 3R→2R',
    rungs: [
      { triggerR: 1, stopR: 0 },
      { triggerR: 2, stopR: 1 },
      { triggerR: 3, stopR: 2 },
    ],
  },
  trail1_5R: { type: RuleType.TRAIL_R, label: 'Trail 1.5R below high', n: 1.5 },
  trail8pct: { type: RuleType.TRAIL_PCT, label: 'Trail 8% below high', pct: 8 },
};

/**
 * @param {object|null} rule
 * @param {object} ctx
 *   entryPrice, riskPerShare, activeStop, highestClose, currentPrice
 * @returns {{
 *   ruleStop: number|null,   where the rule alone puts the stop
 *   target: number,          ratcheted against the active stop
 *   shouldRaise: boolean,    the rule is above the active stop
 *   triggeredBy: string|null,
 *   breached: boolean        rule stop is already at or above current price
 * }}
 */
export function evaluateStopRule(rule, ctx) {
  const { entryPrice, riskPerShare, activeStop, highestClose, currentPrice } = ctx;
  const none = {
    ruleStop: null,
    target: activeStop,
    shouldRaise: false,
    triggeredBy: null,
    breached: false,
  };
  if (!rule || rule.type === RuleType.NONE) return none;
  if (highestClose == null) return none;

  let ruleStop = null;
  let triggeredBy = null;

  switch (rule.type) {
    case RuleType.LADDER: {
      const maxCloseR = (highestClose - entryPrice) / riskPerShare;
      // Highest rung whose trigger has been met on a close.
      const hit = [...(rule.rungs ?? [])]
        .sort((a, b) => a.triggerR - b.triggerR)
        .filter((r) => maxCloseR >= r.triggerR - EPS)
        .pop();
      if (hit) {
        ruleStop = entryPrice + hit.stopR * riskPerShare;
        triggeredBy = `${hit.triggerR}R → ${hit.stopR}R`;
      }
      break;
    }
    case RuleType.TRAIL_R:
      ruleStop = highestClose - rule.n * riskPerShare;
      triggeredBy = `trail ${rule.n}R`;
      break;
    case RuleType.TRAIL_PCT:
      ruleStop = highestClose * (1 - rule.pct / 100);
      triggeredBy = `trail ${rule.pct}%`;
      break;
    case RuleType.TRAIL_USD:
      ruleStop = highestClose - rule.usd;
      triggeredBy = `trail $${rule.usd}`;
      break;
    default:
      return none;
  }

  if (ruleStop == null) return none;

  // Ratchet. A rule never lowers a stop, so a trailing rule that has fallen
  // behind an already-higher manual stop simply has nothing to say.
  const target = Math.max(activeStop, ruleStop);
  return {
    ruleStop,
    target,
    shouldRaise: ruleStop > activeStop + EPS,
    triggeredBy,
    breached: currentPrice != null && ruleStop >= currentPrice - EPS,
  };
}

/**
 * Counterfactual: what would this trade have returned had its rule been
 * followed exactly?
 *
 * Estimated, and labelled as such everywhere it appears. Daily bars cannot
 * resolve whether a day's high or its low came first, so a bar that both
 * breaches the stop and makes a new high is ambiguous. This simulator resolves
 * it conservatively — the stop is checked against the stop level as it stood at
 * the START of the day, and only then does the day's close update the stop.
 *
 * Position sizing is ignored: the simulation holds the original position to the
 * exit, which matches MFE/MAE semantics. It measures what the RULE was worth,
 * not what any particular sizing would have produced.
 *
 * @param {object[]} bars  [{ date, open, high, low, close }] from entry onward
 */
export function simulateRule(rule, { entryPrice, initialStop, riskPerShare, bars }) {
  if (!bars?.length) return null;

  let stop = initialStop;
  let highestClose = -Infinity;
  let exitPrice = null;
  let exitDate = null;
  let exitReason = null;
  let stopMoves = 0;

  for (const bar of bars) {
    // 1. Would the stop as it stood this morning have been hit?
    if (bar.open <= stop + EPS) {
      exitPrice = bar.open; // gapped through the stop
      exitDate = bar.date;
      exitReason = 'gap';
      break;
    }
    if (bar.low <= stop + EPS) {
      exitPrice = stop;
      exitDate = bar.date;
      exitReason = 'stop';
      break;
    }

    // 2. Survived the day. Today's close can now move the stop up.
    highestClose = Math.max(highestClose, bar.close);
    const { target } = evaluateStopRule(rule, {
      entryPrice,
      riskPerShare,
      activeStop: stop,
      highestClose,
      currentPrice: bar.close,
    });
    if (target > stop + EPS) {
      stop = target;
      stopMoves += 1;
    }
  }

  const last = bars[bars.length - 1];
  if (exitPrice == null) {
    exitPrice = last.close;
    exitDate = last.date;
    exitReason = 'still open';
  }

  return {
    exitPrice,
    exitDate,
    exitReason,
    finalStop: stop,
    stopMoves,
    resultR: (exitPrice - entryPrice) / riskPerShare,
    estimated: true,
  };
}
