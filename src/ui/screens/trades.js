/**
 * Trades: the full history, open first.
 *
 * Deliberately dense. This screen is for finding a trade, not for studying one,
 * so each row carries the ticker, the result and enough context to recognise it
 * and nothing more.
 */

import { state } from '../app.js';
import { realizedR, currentR } from '../../core/engine.js';
import { priceFor } from '../app.js';
import { rval, tone, shortDate, dollars, esc } from '../format.js';

export function renderTrades(s) {
  if (!s.trades.length) {
    return `<div class="empty-state"><p>No trades yet.</p>
      <button class="btn primary" data-go="new">Add one</button></div>`;
  }

  const open = s.trades.filter((t) => t.status === 'OPEN');
  const closed = s.trades.filter((t) => t.status === 'CLOSED');

  const row = (t) => {
    const p = priceFor(t.ticker);
    const r = t.status === 'OPEN' ? (p ? currentR(t, p.price) : null) : realizedR(t);
    return `<tr data-go="trade/${t.id}" style="cursor:pointer">
      <td><span class="ticker" style="font-size:var(--step-0)">${esc(t.ticker)}</span></td>
      <td class="muted">${esc(t.setup ?? '—')}</td>
      <td class="muted">${shortDate(t.closedAt ?? t.openedAt)}</td>
      <td class="r ${tone(r)}">${rval(r)}</td>
    </tr>`;
  };

  return `
    ${
      open.length
        ? `<div class="section-title"><span class="label">Open · ${open.length}</span></div>
           <div class="card"><table><tbody>${open.map(row).join('')}</tbody></table></div>`
        : ''
    }
    ${
      closed.length
        ? `<div class="section-title"><span class="label">Closed · ${closed.length}</span></div>
           <div class="card"><table><tbody>${closed.map(row).join('')}</tbody></table></div>`
        : ''
    }`;
}
