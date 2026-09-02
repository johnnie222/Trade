/**
 * CSV export.
 *
 * Two files, because one row per trade cannot answer everything. The trades
 * file is what goes into a spreadsheet; the events file is the raw log, for
 * the questions the trades file flattens away — when exactly a stop moved, what
 * reason was given, which rules were skipped.
 */

import { tradeSummary } from '../core/metrics.js';
import { realizedR } from '../core/engine.js';

/**
 * RFC 4180 quoting. Fields containing a comma, quote or newline are wrapped and
 * inner quotes doubled. A trader's note WILL eventually contain a comma, and an
 * export that corrupts on the first one is worse than no export.
 */
export function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(headers, rows) {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}

const n = (x, dp = 4) => (x == null || !Number.isFinite(x) ? '' : Number(x.toFixed(dp)));
const date = (iso) => (iso ? iso.slice(0, 10) : '');

export const TRADE_HEADERS = [
  'trade_id', 'ticker', 'setup', 'status',
  'entry_date', 'entry_price', 'initial_stop', 'final_stop',
  'risk_per_share', 'initial_qty', 'R_dollars',
  'exit_date', 'exit_price', 'exit_reason',
  'realized_pnl', 'realized_R',
  'mfe_R', 'mae_R', 'mfe_captured', 'round_trip',
  'stop_changes', 'stop_widenings', 'rule_overrides',
  'holding_days', 'entry_emotion', 'plan_followed', 'thesis', 'lesson',
];

export function tradesCsv(trades, barsByTicker = {}) {
  const rows = trades.map((t) => {
    const s = tradeSummary(t, barsByTicker[t.ticker] ?? null);
    return [
      t.id, t.ticker, t.setup, t.status,
      date(t.openedAt), n(t.entryPrice), n(t.initialStop), n(t.activeStop),
      n(t.riskPerShare), n(t.initialQty), n(t.R, 2),
      date(t.closedAt), n(t.exitPrice), t.exitReason,
      n(t.realizedPnl, 2), n(s.realizedR),
      n(s.mfeR), n(s.maeR), n(s.mfeCaptured), s.roundTrip ? 'yes' : 'no',
      s.stopChanges, s.stopWidenings, s.ruleOverrides,
      s.holdingDays, s.entryEmotion, t.planFollowed ?? '', t.thesis ?? '', t.lesson ?? '',
    ];
  });
  return toCsv(TRADE_HEADERS, rows);
}

export const EVENT_HEADERS = [
  'timestamp', 'ticker', 'trade_id', 'event', 'price', 'qty',
  'stop_from', 'stop_to', 'source', 'reason', 'note',
];

export function eventsCsv(log) {
  const rows = log.map((e) => {
    const p = e.payload ?? {};
    return [
      e.at, e.ticker ?? '', e.tradeId ?? '', e.type,
      n(p.price ?? p.exitPrice), n(p.qty),
      n(p.from), n(p.to ?? p.ruleStop),
      p.source ?? '', p.reason ?? '', e.note ?? p.text ?? '',
    ];
  });
  return toCsv(EVENT_HEADERS, rows);
}

/** Realized R for a set of trades, used by the review header. */
export function netR(trades) {
  return trades.reduce((a, t) => a + realizedR(t), 0);
}
