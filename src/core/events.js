/**
 * The event log vocabulary.
 *
 * A trade IS its ordered list of events. Nothing else is stored. Every number
 * on every screen is a projection of this list (see engine.js).
 *
 * Corrections edit an event in place and append a TRADE_EDIT alongside, so the
 * projection uses the corrected value while the log preserves that a
 * correction happened.
 */

export const EventType = {
  OPEN: 'OPEN',
  ADD: 'ADD',
  TRIM: 'TRIM',
  STOP_CHANGE: 'STOP_CHANGE',
  RULE_OVERRIDE: 'RULE_OVERRIDE',
  RULE_CHANGE: 'RULE_CHANGE',
  SPLIT: 'SPLIT',
  NOTE: 'NOTE',
  CLOSE: 'CLOSE',
  TRADE_EDIT: 'TRADE_EDIT',
};

export const StopSource = {
  INITIAL: 'initial',
  MANUAL: 'manual',
  RULE: 'rule',
};

let counter = 0;

/** Monotonic id. Random suffix so ids stay unique across devices for later sync. */
export function newId(prefix = 'e') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/**
 * @param {string} type
 * @param {string} at        ISO 8601 timestamp
 * @param {object} payload
 * @param {object} [extra]   { note, screenshotIds }
 */
export function event(type, at, payload = {}, extra = {}) {
  return {
    id: newId(),
    type,
    at,
    payload,
    note: extra.note ?? null,
    screenshotIds: extra.screenshotIds ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

export const open = (at, { price, qty, stop, rule = null }, extra) =>
  event(EventType.OPEN, at, { price, qty, stop, rule }, extra);

export const add = (at, { price, qty }, extra) =>
  event(EventType.ADD, at, { price, qty }, extra);

export const trim = (at, { price, qty }, extra) =>
  event(EventType.TRIM, at, { price, qty }, extra);

/** `from` is derived by the projection, never trusted from the payload. */
export const stopChange = (at, { to, reason = null, source = StopSource.MANUAL, priceAtTime = null }, extra) =>
  event(EventType.STOP_CHANGE, at, { to, reason, source, priceAtTime }, extra);

/** The trader saw what the rule said and chose not to take it. */
export const ruleOverride = (at, { ruleStop, actualStop, reason = null }, extra) =>
  event(EventType.RULE_OVERRIDE, at, { ruleStop, actualStop, reason }, extra);

export const ruleChange = (at, { rule }, extra) =>
  event(EventType.RULE_CHANGE, at, { rule }, extra);

/** 2:1 forward split => numerator 2, denominator 1. Reverse split: 1:10. */
export const split = (at, { numerator, denominator }, extra) =>
  event(EventType.SPLIT, at, { numerator, denominator }, extra);

export const note = (at, { text }, extra) =>
  event(EventType.NOTE, at, { text }, extra);

export const close = (at, { price, reason = null }, extra) =>
  event(EventType.CLOSE, at, { price, reason }, extra);

export const tradeEdit = (at, { targetEventId, field, from, to }, extra) =>
  event(EventType.TRADE_EDIT, at, { targetEventId, field, from, to }, extra);

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export class TradeError extends Error {}

export function validateOpen(payload) {
  const { price, qty, stop } = payload;
  if (!(price > 0)) throw new TradeError('Entry price must be positive');
  if (!(qty > 0)) throw new TradeError('Quantity must be positive');
  if (!(stop > 0)) throw new TradeError('Stop must be positive');
  // Long only. A stop at or above entry means zero or negative risk, which
  // makes R undefined and every downstream metric meaningless.
  if (stop >= price) throw new TradeError('Stop must be below entry price (long only)');
}
