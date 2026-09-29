/**
 * Trades V9: searchable locator with open/closed segmentation.
 * Closed trades are R-first and grouped by exit date in chronological views.
 */

import { ACTIONS, LIVE } from '../registry.js';
import { priceFor, state, render } from '../app.js';
import { totalPnl, currentR, realizedR } from '../../core/engine.js';
import { dollars, price as fmtPrice, daysBetween, esc } from '../format.js';

const SORTS = [
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['bestR', 'Best R'],
  ['worstR', 'Worst R'],
  ['hold', 'Hold time'],
];

const view = () => (state.draft.trades ??= {
  tab: 'open',
  query: '',
  sort: 'newest',
  closedVisible: 4,
});

function tradeR(t) {
  if (t.status === 'CLOSED') return realizedR(t);
  const p = priceFor(t.ticker);
  return p ? currentR(t, p.price) : null;
}

function cashResult(t) {
  if (t.status === 'CLOSED') return t.realizedPnl;
  const p = priceFor(t.ticker);
  return p ? totalPnl(t, p.price) : null;
}

function rTone(r) {
  if (r == null || !Number.isFinite(r) || Math.abs(r) < 0.1) return 'neutral';
  return r > 0 ? 'pos' : 'neg';
}

function rText(r) {
  if (r == null || !Number.isFinite(r)) return '—';
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function dateLabel(iso) {
  if (!iso) return 'UNKNOWN';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  }).toUpperCase();
}

function matches(t, q) {
  if (!q) return true;
  const haystack = [
    t.ticker,
    t.setup,
    t.exitReason,
    t.thesis,
    t.leaderStatus,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function sortTrades(rows, mode) {
  const out = [...rows];
  const opened = (t) => new Date(t.openedAt ?? 0).getTime();
  const closed = (t) => new Date(t.closedAt ?? t.openedAt ?? 0).getTime();
  const hold = (t) => daysBetween(t.openedAt, t.closedAt ?? new Date()) ?? 0;

  switch (mode) {
    case 'oldest':
      return out.sort((a, b) => (a.status === 'CLOSED' ? closed(a) - closed(b) : opened(a) - opened(b)));
    case 'bestR':
      return out.sort((a, b) => (tradeR(b) ?? -Infinity) - (tradeR(a) ?? -Infinity));
    case 'worstR':
      return out.sort((a, b) => (tradeR(a) ?? Infinity) - (tradeR(b) ?? Infinity));
    case 'hold':
      return out.sort((a, b) => hold(b) - hold(a));
    case 'newest':
    default:
      return out.sort((a, b) => (b.status === 'CLOSED' ? closed(b) - closed(a) : opened(b) - opened(a)));
  }
}

function subtitle(t) {
  const duration = daysBetween(t.openedAt, t.closedAt ?? new Date());
  if (t.status === 'CLOSED') {
    return `${esc(t.exitReason ?? 'Closed')} · exit ${fmtPrice(t.exitPrice)}${duration ? ` · ${duration} day${duration === 1 ? '' : 's'}` : ''}`;
  }
  return `${esc(t.setup ?? 'Open trade')} · stop ${fmtPrice(t.activeStop)}${duration ? ` · day ${duration}` : ''}`;
}

function tradeRow(t) {
  const r = tradeR(t);
  const cash = cashResult(t);
  return `
    <button class="trade-list-row" data-go="trade/${t.id}">
      <span class="trade-list-main">
        <strong class="ticker">${esc(t.ticker)}</strong>
        <span class="trade-list-sub">${subtitle(t)}</span>
      </span>
      <span class="trade-list-result">
        <span class="r-chip ${rTone(r)}">${rText(r)}</span>
        <span class="trade-list-cash ${cash == null || Math.abs(cash) < 1 ? 'neutral' : cash > 0 ? 'pos' : 'neg'}">${dollars(cash)}</span>
      </span>
      <span class="trade-chevron">›</span>
    </button>`;
}

function card(rows) {
  return `<div class="card trade-list-card">${rows.map(tradeRow).join('')}</div>`;
}

function closedGroups(rows, sortMode) {
  if (!['newest', 'oldest'].includes(sortMode)) {
    return rows.length ? `<div class="trade-date">RESULTS</div>${card(rows)}` : '';
  }
  const groups = [];
  for (const t of rows) {
    const label = dateLabel(t.closedAt);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(t);
    else groups.push({ label, rows: [t] });
  }
  return groups.map((g) => `<div class="trade-date">${g.label}</div>${card(g.rows)}`).join('');
}

function refocusSearch() {
  requestAnimationFrame(() => {
    const input = document.getElementById('trade-search');
    if (!input) return;
    input.focus();
    const n = input.value.length;
    input.setSelectionRange?.(n, n);
  });
}

export function renderTrades(s) {
  if (!s.trades.length) {
    return `<div class="empty-state">
      <p class="empty-title">No trades yet</p>
      <button class="btn primary" data-go="new">Add one</button>
    </div>`;
  }

  const v = view();
  const openAll = s.trades.filter((t) => t.status === 'OPEN');
  const closedAll = s.trades.filter((t) => t.status === 'CLOSED');
  const source = v.tab === 'closed' ? closedAll : openAll;
  const filtered = sortTrades(source.filter((t) => matches(t, v.query.trim())), v.sort);

  let body;
  if (v.tab === 'closed') {
    const visible = v.query.trim() ? filtered : filtered.slice(0, v.closedVisible);
    body = closedGroups(visible, v.sort);
    const remaining = filtered.length - visible.length;
    if (remaining > 0) {
      body += `<button class="show-earlier" data-action="showEarlier">Show ${remaining} earlier trade${remaining === 1 ? '' : 's'}</button>`;
    }
  } else {
    body = filtered.length ? card(filtered) : '';
  }

  return `
    <div class="trades-tools">
      <div class="trade-search-wrap">
        <span aria-hidden="true">⌕</span>
        <input id="trade-search" data-live="tradesSearch" value="${esc(v.query)}" placeholder="Search trades" autocomplete="off">
      </div>
      <div class="trades-tool-row">
        <select id="trade-sort" class="trade-sort" aria-label="Sort trades">
          ${SORTS.map(([value, label]) => `<option value="${value}" ${v.sort === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="chip" data-go="log">Activity log</button>
      </div>
    </div>

    <div class="segmented trade-tabs">
      <button data-action="tradesTab" data-v="open" aria-pressed="${v.tab === 'open'}">Open · ${openAll.length}</button>
      <button data-action="tradesTab" data-v="closed" aria-pressed="${v.tab === 'closed'}">Closed · ${closedAll.length}</button>
    </div>

    <div class="trade-results">
      ${body || `<div class="empty-state compact"><p class="muted">No matching ${v.tab} trades.</p></div>`}
    </div>`;
}

LIVE.tradesSearch = (el) => {
  view().query = el.value;
  render();
  refocusSearch();
};

ACTIONS.tradesTab = (el) => {
  view().tab = el.dataset.v === 'closed' ? 'closed' : 'open';
  render();
};

ACTIONS.showEarlier = () => {
  view().closedVisible += 5;
  render();
};

document.addEventListener('change', (e) => {
  const el = e.target.closest?.('#trade-sort');
  if (!el) return;
  view().sort = SORTS.some(([value]) => value === el.value) ? el.value : 'newest';
  render();
});
