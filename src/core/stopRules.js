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

/**
 * Presets, defined once in Settings and picked from a dropdown at open.
 *
 * A ladder answers "protect a milestone once it is reached" and then has
 * nothing more to say — past its last rung the stop simply stops moving. That
 * is fine if you intend to manage the tail by hand, and wrong if you do not,
 * because the largest winners spend most of their life past the last rung.
 *
 * `then` closes that gap: once the final rung is cleared, a trailing rule takes
 * over. Ladder for the early protection, trail for the run.
 */
export const PRESETS = {
  discretionary: { type: RuleType.NONE, label: 'Manual — no rule' },

  beAt1R: {
    type: RuleType.LADDER,
    label: 'Breakeven at 1R, then manual',
    rungs: [{ triggerR: 1, stopR: 0 }],
  },

  ladderClassic: {
    type: RuleType.LADDER,
    label: '1R→BE, 2R→1R, 3R→2R, then manual',
    rungs: [
      { triggerR: 1, stopR: 0 },
      { triggerR: 2, stopR: 1 },
      { triggerR: 3, stopR: 2 },
    ],
  },

  ladderThenTrail: {
    type: RuleType.LADDER,
    label: '1R→BE, 2R→1R, then trail',
    rungs: [
      { triggerR: 1, stopR: 0 },
      { triggerR: 2, stopR: 1 },
    ],
    then: { type: RuleType.TRAIL_PCT, pct: 8 },
  },

  trailOnly: { type: RuleType.TRAIL_PCT, label: 'Trail from the start', pct: 8 },

  trail1_5R: { type: RuleType.TRAIL_R, label: 'Trail 1.5R below the high', n: 1.5 },
};

/** Which presets read their trail value from Settings. */
export const CONFIGURABLE = ['ladderThenTrail', 'trailOnly'];

/**
 * Fill a preset's trailing leg from the trader's own setting.
 *
 * Presets are shapes, not values. "Trail 8%" is a shape; whether 8 is the right
 * number is a decision that belongs to the person, and hard-coding it would
 * mean every trader gets the author's guess.
 *
 * @param {string} key
 * @param {object} [settings]  { trailType: 'TRAIL_PCT'|'TRAIL_USD'|'TRAIL_R', trailValue: number }
 */
export function resolveRule(key, settings = {}) {
  const preset = PRESETS[key];
  if (!preset) return PRESETS.discretionary;
  if (!CONFIGURABLE.includes(key)) return preset;

  const type = settings.trailType ?? RuleType.TRAIL_PCT;
  const value = Number(settings.trailValue ?? 8);
  const leg = { type };
  if (type === RuleType.TRAIL_PCT) leg.pct = value;
  else if (type === RuleType.TRAIL_USD) leg.usd = value;
  else leg.n = value;

  const suffix =
    type === RuleType.TRAIL_PCT ? `${value}%` : type === RuleType.TRAIL_USD ? `$${value}` : `${value}R`;

  return preset.type === RuleType.LADDER
    ? { ...preset, label: `1R→BE, 2R→1R, then trail ${suffix}`, then: leg }
    : { ...preset, ...leg, label: `Trail ${suffix} from the start` };
}

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
      const rungs = [...(rule.rungs ?? [])].sort((a, b) => a.triggerR - b.triggerR);
      const hit = rungs.filter((r) => maxCloseR >= r.triggerR - EPS).pop();
      if (hit) {
        ruleStop = entryPrice + hit.stopR * riskPerShare;
        triggeredBy = `${hit.triggerR}R → ${hit.stopR}R`;
      }

      // Past the last rung the trailing leg takes over. Both are evaluated and
      // the higher wins, so the handoff can never lower a stop the ladder has
      // already earned.
      const last = rungs.at(-1);
      if (rule.then && last && maxCloseR >= last.triggerR - EPS) {
        const tail = evaluateStopRule({ ...rule.then, rungs: undefined, then: undefined }, ctx);
        if (tail.ruleStop != null && (ruleStop == null || tail.ruleStop > ruleStop)) {
          ruleStop = tail.ruleStop;
          triggeredBy = tail.triggeredBy;
        }
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
