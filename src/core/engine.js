/**
 * The projection engine.
 *
 * projectTrade(events) folds an append-only event log into the current state
 * of a trade. It is a pure function: same log in, same state out, always.
 * There is no stored calculated state anywhere in the product, so fixing a
 * formula here fixes every historical trade on the next render.
 *
 * THE ONE INVARIANT
 *
 *   R = (entryPrice - initialStop) * initialQty     [dollars, locked at open]
 *
 * R never changes. Not on an add, not on a trim, not when the stop is raised,
 * not on a split. It is the dollar amount the trader originally decided to
 * risk, and holding it fixed is what makes a $40 stock and a $900 stock
 * directly comparable.
 */

import { EventType, StopSource, TradeError, validateOpen } from './events.js';
import { EPS } from './money.js';

export const TradeStatus = { OPEN: 'OPEN', CLOSED: 'CLOSED' };

/**
 * @param {object[]} events  ordered oldest-first
 * @param {object} [meta]    { id, ticker, account, setup, thesis, ... }
 */
export function projectTrade(events, meta = {}) {
  if (!events.length) throw new TradeError('A trade needs at least an OPEN event');
  if (events[0].type !== EventType.OPEN) throw new TradeError('First event must be OPEN');

  const s = {
    ...meta,
    status: TradeStatus.OPEN,
    openedAt: null,
    closedAt: null,

    // locked at open, adjusted by splits (R stays invariant)
    entryPrice: 0,
    initialStop: 0,
    initialQty: 0,
    riskPerShare: 0,
    R: 0,

    // live position
    qty: 0,
    avgCost: 0,
    activeStop: 0,
    realizedPnl: 0,
    exitPrice: null,
    exitReason: null,

    // `...meta` is spread first so computed fields below always win. That means
    // any field the trade record also carries must be seeded from meta here, or
    // the default silently overwrites it.
    rule: meta.rule ?? null,
    splitFactor: 1, // cumulative shares-out / shares-in

    stopHistory: [],
    ruleOverrides: [],
    notes: [],
    events,

    // behavioural counters, free to compute here and used by the reviews
    stopChanges: 0,
    stopWidenings: 0,
    adds: 0,
    trims: 0,
  };

  for (const ev of events) {
    apply(s, ev);
  }
  return s;
}

function apply(s, ev) {
  const p = ev.payload;

  switch (ev.type) {
    case EventType.OPEN: {
      validateOpen(p);
      s.openedAt = ev.at;
      s.entryPrice = p.price;
      s.initialStop = p.stop;
      s.initialQty = p.qty;
      s.riskPerShare = p.price - p.stop;
      s.R = s.riskPerShare * p.qty;
      s.qty = p.qty;
      s.avgCost = p.price;
      s.activeStop = p.stop;
      // The rule may be carried on the event or set on the trade record. An
      // OPEN without one must not wipe a rule the trade already declares.
      s.rule = p.rule ?? s.rule ?? null;
      s.stopHistory.push({
        at: ev.at,
        from: null,
        to: p.stop,
        source: StopSource.INITIAL,
        reason: null,
        rAtTime: 0,
      });
      break;
    }

    case EventType.ADD: {
      if (s.status === TradeStatus.CLOSED) throw new TradeError('Cannot add to a closed trade');
      if (!(p.qty > 0)) throw new TradeError('Add quantity must be positive');
      // Weighted average cost. This moves the breakeven point but NOT R.
      s.avgCost = (s.avgCost * s.qty + p.price * p.qty) / (s.qty + p.qty);
      s.qty += p.qty;
      s.adds += 1;
      break;
    }

    case EventType.TRIM: {
      if (s.status === TradeStatus.CLOSED) throw new TradeError('Cannot trim a closed trade');
      if (!(p.qty > 0)) throw new TradeError('Trim quantity must be positive');
      if (p.qty > s.qty + EPS) throw new TradeError('Cannot trim more than the open position');
      s.realizedPnl += p.qty * (p.price - s.avgCost);
      s.qty -= p.qty;
      s.trims += 1;
      if (s.qty < EPS) {
        s.qty = 0;
        s.status = TradeStatus.CLOSED;
        s.closedAt = ev.at;
        s.exitPrice = p.price;
      }
      break;
    }

    case EventType.STOP_CHANGE: {
      if (!(p.to > 0)) throw new TradeError('Stop must be positive');
      const from = s.activeStop;
      // A widened stop is allowed. This is a journal: it records what the
      // trader did, not what the trader should have done. Widening is itself
      // one of the more informative behaviours to be able to count later.
      if (p.to < from - EPS) s.stopWidenings += 1;
      s.activeStop = p.to;
      s.stopChanges += 1;
      s.stopHistory.push({
        at: ev.at,
        from,
        to: p.to,
        source: p.source ?? StopSource.MANUAL,
        reason: p.reason ?? null,
        rAtTime: p.priceAtTime != null ? currentR(s, p.priceAtTime) : null,
        widened: p.to < from - EPS,
      });
      break;
    }

    case EventType.RULE_OVERRIDE: {
      s.ruleOverrides.push({
        at: ev.at,
        ruleStop: p.ruleStop,
        actualStop: p.actualStop ?? s.activeStop,
        reason: p.reason ?? null,
      });
      break;
    }

    case EventType.RULE_CHANGE: {
      s.rule = p.rule;
      break;
    }

    case EventType.SPLIT: {
      const { numerator: n, denominator: d } = p;
      if (!(n > 0) || !(d > 0)) throw new TradeError('Split ratio must be positive');
      const shareFactor = n / d; // 2:1 => 2x shares
      const priceFactor = d / n; // 2:1 => half price

      s.entryPrice *= priceFactor;
      s.initialStop *= priceFactor;
      s.avgCost *= priceFactor;
      s.activeStop *= priceFactor;
      s.riskPerShare *= priceFactor;
      s.initialQty *= shareFactor;
      s.qty *= shareFactor;
      s.splitFactor *= shareFactor;
      // realizedPnl is already in dollars and is not touched.
      // R is untouched by construction: riskPerShare * priceFactor
      // times initialQty * shareFactor = the same number.
      s.stopHistory = s.stopHistory.map((h) => ({
        ...h,
        from: h.from == null ? null : h.from * priceFactor,
        to: h.to * priceFactor,
      }));
      break;
    }

    case EventType.NOTE: {
      s.notes.push({ at: ev.at, text: p.text });
      break;
    }

    case EventType.CLOSE: {
      if (s.status === TradeStatus.CLOSED) throw new TradeError('Trade is already closed');
      s.realizedPnl += s.qty * (p.price - s.avgCost);
      s.qty = 0;
      s.status = TradeStatus.CLOSED;
      s.closedAt = ev.at;
      s.exitPrice = p.price;
      s.exitReason = p.reason ?? null;
      break;
    }

    case EventType.TRADE_EDIT:
      // Bookkeeping only. The corrected value already lives in the target event.
      break;

    default:
      throw new TradeError(`Unknown event type: ${ev.type}`);
  }
}

/* ------------------------------------------------------------------ */
/* Derived numbers                                                     */
/* ------------------------------------------------------------------ */

/** Target price for a given R multiple. Display reference only. */
export function priceAtR(s, r) {
  return s.entryPrice + r * s.riskPerShare;
}

export function realizedR(s) {
  return s.realizedPnl / s.R;
}

export function openPnl(s, currentPrice) {
  return s.qty * (currentPrice - s.avgCost);
}

export function totalPnl(s, currentPrice) {
  return s.realizedPnl + openPnl(s, currentPrice);
}

/**
 * Current R including both realized and open portions.
 * With no adds and no trims this reduces exactly to
 *   (currentPrice - entryPrice) / riskPerShare
 */
export function currentR(s, currentPrice) {
  return totalPnl(s, currentPrice) / s.R;
}

/**
 * Open risk in dollars, measured from average cost to the active stop.
 * Returns 0 once the stop is above cost — that position can no longer lose
 * money at its stop, so it contributes nothing to portfolio risk.
 */
export function openRisk(s) {
  if (s.status === TradeStatus.CLOSED) return 0;
  return Math.max(0, s.avgCost - s.activeStop) * s.qty;
}

/** Dollars locked in if the stop fills. Negative before the stop clears cost. */
export function lockedIn(s) {
  if (s.status === TradeStatus.CLOSED) return 0;
  return s.realizedPnl + (s.activeStop - s.avgCost) * s.qty;
}

export function isProtected(s) {
  return s.status === TradeStatus.OPEN && s.activeStop >= s.avgCost - EPS;
}

export function stopDistancePct(s, currentPrice) {
  return ((currentPrice - s.activeStop) / currentPrice) * 100;
}

/**
 * Portfolio-level open risk. Assumes every stop fills at its price, which a
 * gap makes false. The UI must label it "excludes gaps" rather than presenting
 * it as a guarantee.
 */
export function portfolioRisk(trades) {
  const open = trades.filter((t) => t.status === TradeStatus.OPEN);
  const risks = open.map(openRisk);
  return {
    total: risks.reduce((a, b) => a + b, 0),
    count: open.length,
    largest: risks.length ? Math.max(...risks) : 0,
  };
}

/** Computed, never stored. */
export function tradeStatusLabel(s, currentPrice) {
  if (s.status === TradeStatus.CLOSED) return 'Closed';
  const r = currentR(s, currentPrice);
  const toStop = currentPrice - s.activeStop;
  const entryToStop = s.avgCost - s.activeStop;
  if (entryToStop > 0 && toStop <= entryToStop * 0.25) return 'Near Stop';
  if (r >= 2) return 'At 2R';
  if (r >= 1) return 'At 1R';
  if (isProtected(s)) return 'Protected';
  return 'Open';
}
