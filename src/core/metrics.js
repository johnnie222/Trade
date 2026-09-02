/**
 * MFE / MAE and the round-trip flag.
 *
 * MFE and MAE are pure PRICE ratios against the original entry:
 *
 *   MFE_R = (maxHigh - entryPrice) / riskPerShare
 *   MAE_R = (minLow  - entryPrice) / riskPerShare
 *
 * Two consequences, both intentional:
 *
 * 1. They ignore adds and trims. They measure what the trade OFFERED, not what
 *    the trader captured. The gap between MFE_R and realized R is exactly the
 *    thing worth looking at, and collapsing the two would erase it.
 *
 * 2. They are daily resolution. A trade that touched -0.9R intraday and closed
 *    the day at -0.2R reports -0.2R. Every label in the UI says "(daily)" so
 *    the number is never mistaken for an intraday measurement.
 */

import { realizedR } from './engine.js';

export const ROUND_TRIP = {
  MIN_MFE_R: 1.5,
  MAX_CAPTURE: 0.35,
};

/**
 * Capture is a ratio, so a near-zero denominator makes it explode. A trade
 * whose high was 0.1R above entry never offered anything to capture, but
 * realized/0.1 produces numbers like -1000%, which then poison every average
 * that includes them. Below this floor, capture is reported as absent.
 */
export const MIN_MFE_FOR_CAPTURE = 0.25;

/** Bars overlapping [openedAt, closedAt]. closedAt null means still open. */
export function barsForTrade(bars, openedAt, closedAt) {
  const from = new Date(openedAt).setHours(0, 0, 0, 0);
  const to = closedAt ? new Date(closedAt).setHours(23, 59, 59, 999) : Infinity;
  return bars.filter((b) => {
    const t = new Date(b.date).getTime();
    return t >= from && t <= to;
  });
}

/**
 * @returns {{ mfeR, maeR, maxHigh, minLow, bars, resolution } | null}
 */
export function excursions(state, bars) {
  const window = barsForTrade(bars, state.openedAt, state.closedAt);
  if (!window.length) return null;

  const maxHigh = Math.max(...window.map((b) => b.high));
  const minLow = Math.min(...window.map((b) => b.low));

  return {
    mfeR: (maxHigh - state.entryPrice) / state.riskPerShare,
    maeR: (minLow - state.entryPrice) / state.riskPerShare,
    maxHigh,
    minLow,
    bars: window.length,
    resolution: 'daily',
  };
}

/**
 * Fraction of the available move that was actually realized.
 *
 * Null when the trade never offered a meaningful move. A negative result is
 * kept rather than clamped: "2.8R was available and you finished down" is one
 * of the more useful things this number can say.
 */
export function mfeCaptured(state, exc) {
  if (!exc || exc.mfeR < MIN_MFE_FOR_CAPTURE) return null;
  return realizedR(state) / exc.mfeR;
}

/**
 * Flags the event. Does not judge the trade.
 *
 * A deliberate structure-based hold and sloppy profit protection are
 * indistinguishable to a formula — both are "gave back most of a big move".
 * The flag surfaces the trade so the trader can read their own timeline and
 * decide which one it was.
 */
export function isRoundTrip(state, exc) {
  if (!exc || state.status !== 'CLOSED') return false;
  if (exc.mfeR < ROUND_TRIP.MIN_MFE_R) return false;
  return realizedR(state) <= ROUND_TRIP.MAX_CAPTURE * exc.mfeR;
}

/** Everything a closed trade contributes to a review, in one object. */
export function tradeSummary(state, bars = null) {
  const exc = bars ? excursions(state, bars) : null;
  const captured = mfeCaptured(state, exc);
  return {
    id: state.id,
    ticker: state.ticker,
    setup: state.setup ?? null,
    status: state.status,
    openedAt: state.openedAt,
    closedAt: state.closedAt,
    entryPrice: state.entryPrice,
    initialStop: state.initialStop,
    R: state.R,
    realizedR: realizedR(state),
    mfeR: exc?.mfeR ?? null,
    maeR: exc?.maeR ?? null,
    mfeCaptured: captured,
    roundTrip: isRoundTrip(state, exc),
    stopChanges: state.stopChanges,
    stopWidenings: state.stopWidenings,
    ruleOverrides: state.ruleOverrides.length,
    entryEmotion: state.entryEmotion ?? null,
    exitReason: state.exitReason ?? null,
    holdingDays:
      state.closedAt
        ? Math.max(
            1,
            Math.round(
              (new Date(state.closedAt) - new Date(state.openedAt)) / 86400000
            )
          )
        : null,
  };
}
