/**
 * Trades: the full history, open first.
 *
 * Deliberately dense. This screen is for finding a trade, not studying one, so
 * each row carries the ticker, the move in percent, the result in R and in
 * dollars, and nothing else.
 *
 * Percent and R answer different questions and neither replaces the other. A
 * 3% move is a 2R win on a tight stop and a scratch on a wide one — percent
 * says what the stock did, R says what the decision was worth.
 */

import { state, priceFor } from '../app.js';
import { realizedR, currentR, totalPnl } from '../../core/engine.js';
import { rval, dollars, tone, shortDate, esc } from '../format.js';

function pctChange(t) {
  const to = t.status === 'OPEN' ? priceFor(t.ticker)?.price : t.exitPrice;
  if (to == null || !t.entryPrice) return null;
  return (to - t.entryPrice) / t.entryPrice;
}

function row(t) {
  const p = priceFor(t.ticker);
  const isOpen = t.status === 'OPEN';
  const r = isOpen ? (p ? currentR(t, p.price) : null) : realizedR(t);
  const cash = isOpen ? (p ? totalPnl(t, p.price) : null) : t.realizedPnl;
  const chg = pctChange(t);

  return `<tr data-go="trade/${t.id}" tabindex="0">
    <td>
      <span class="ticker sm">${esc(t.ticker)}</span>
      <span class="row-sub">${esc(t.setup ?? 'Untagged')}</span>
    </td>
    <td class="num ${tone(chg)}">${chg == null ? '&mdash;' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(2)}%`}</td>
    <td>
      <span class="r ${tone(r)}">${rval(r)}</span>
      <span class="row-sub ${tone(cash)}">${dollars(cash)}</span>
    </td>
    <td class="muted">${shortDate(t.closedAt ?? t.openedAt)}</td>
  </tr>`;
}

function table(rows) {
  return `<div class="card pad-0">
    <table class="rows">
      <thead><tr><th>Trade</th><th>Move</th><th>Result</th><th>Date</th></tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table>
  </div>`;
}

export function renderTrades(s) {
  if (!s.trades.length) {
    return `<div class="empty-state">
      <p class="empty-title">No trades yet</p>
      <button class="btn primary" data-go="new">Add one</button>
    </div>`;
  }

  const open = s.trades.filter((t) => t.status === 'OPEN');
  const closed = s.trades.filter((t) => t.status === 'CLOSED');

  return `
    ${open.length ? `<div class="section-title"><span class="label">Open · ${open.length}</span></div>${table(open)}` : ''}
    ${
      closed.length
        ? `<div class="section-title"><span class="label">Closed · ${closed.length}</span></div>${table(closed)}`
        : ''
    }`;
}
