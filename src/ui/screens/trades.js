/**
 * Trades: compact locator, not a second Today screen.
 *
 * No R and no calendar date here. The row answers four quick questions:
 * stock move from the original buy, dollar result, active stop, and what is
 * locked. Closed rows add duration under the ticker.
 */

import { priceFor } from '../app.js';
import { totalPnl, lockedIn, isProtected } from '../../core/engine.js';
import { dollars, price as fmtPrice, tone, daysBetween, esc } from '../format.js';

function pctChange(t) {
  const to = t.status === 'OPEN' ? priceFor(t.ticker)?.price : t.exitPrice;
  if (to == null || !t.entryPrice) return null;
  return (to - t.entryPrice) / t.entryPrice;
}

function row(t) {
  const p = priceFor(t.ticker);
  const isOpen = t.status === 'OPEN';
  const cash = isOpen ? (p ? totalPnl(t, p.price) : null) : t.realizedPnl;
  const chg = pctChange(t);
  const locked = isOpen && isProtected(t) ? Math.max(0, lockedIn(t)) : null;
  const duration = !isOpen ? daysBetween(t.openedAt, t.closedAt) : null;

  return `<tr data-go="trade/${t.id}" tabindex="0">
    <td>
      <span class="ticker sm">${esc(t.ticker)}</span>
      ${duration != null ? `<span class="row-sub">${duration} day${duration === 1 ? '' : 's'}</span>` : ''}
    </td>
    <td class="num ${tone(chg)}">
      ${chg == null ? '&mdash;' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(2)}%`}
      <span class="row-sub ${tone(cash)}">${dollars(cash)}</span>
    </td>
    <td class="num">${fmtPrice(t.activeStop)}</td>
    <td class="num ${tone(locked)}">${locked == null ? '&mdash;' : dollars(locked)}</td>
  </tr>`;
}

function table(rows) {
  return `<div class="card pad-0 trades-compact">
    <table class="rows">
      <thead><tr><th>Trade</th><th>Change</th><th>Stop</th><th>Locked</th></tr></thead>
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
