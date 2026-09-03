/**
 * App shell: state, routing and the actions every screen calls.
 *
 * Rendering is a plain function of state to an HTML string, re-run on change.
 * No framework, no build step, no dependency that can break offline.
 */

import { ACTIONS, LIVE } from './registry.js';
import { IdbStore, MemoryStore } from '../data/store.js';
import { Repository } from '../data/repo.js';
import { autoBackup } from '../data/browserBackup.js';
import * as E from '../core/events.js';
import { tradeSummary } from '../core/metrics.js';
import { resolveRule, withTradeTrailing } from '../core/stopRules.js';
import {
  fetchQuote,
  fetchLogo,
  getTwelveDataKey,
  updatePrices,
  summarize,
  defaultProviders,
} from '../data/marketData.js';
import { updateMarketClock } from './marketClock.js';

import { renderHome } from './screens/home.js';
import { renderNewTrade } from './screens/newTrade.js';
import { renderTrades } from './screens/trades.js';
import { renderTradeDetail } from './screens/tradeDetail.js';
import { renderLog } from './screens/log.js';
import { renderStats } from './screens/stats.js';
import { renderSettings } from './screens/settings.js';

export const state = {
  route: { name: 'home', params: {} },
  repo: null,
  trades: [],
  log: [],
  settings: {
    equity: 50000,
    riskPct: 1,
    defaultRule: 'ladderClassic',
    theme: 'system',
    marketHours: 'regular',
  },
  /** { running, done, total, ticker } while the explicit price queue is working. */
  priceSync: null,
  /** Quotes are observations, not trade events. */
  prices: {},
  /** Cached Twelve Data logo URLs. { TICKER: { url, checkedAt } } */
  logos: {},
  highs: {},
  priceSheet: null,
  toast: null,
  draft: {},
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

export async function boot() {
  let store;
  try {
    store = await IdbStore.open();
  } catch (err) {
    console.error('IndexedDB unavailable, running in memory', err);
    store = new MemoryStore();
    state.toast = 'Storage is unavailable. Nothing will be saved this session.';
  }
  state.repo = new Repository(store);

  await loadSettings();
  loadPriceSheetDraft();
  await refresh();
  applyTheme();

  window.addEventListener('hashchange', () => {
    parseRoute();
    render();
    refreshRoutePrice().catch(() => {});
  });
  parseRoute();
  render();
  refreshRoutePrice().catch(() => {});

  // The NY clock is local calculation only — no market-data polling.
  window.setInterval(() => updateMarketClock(state.settings.marketHours), 30000);

  autoBackup(state.repo).catch((err) => console.warn('Backup skipped', err));
}

async function loadSettings() {
  const keys = ['equity', 'riskPct', 'defaultRule', 'theme', 'marketHours'];
  for (const k of keys) {
    const v = await state.repo.getSetting(k, state.settings[k]);
    if (v != null) state.settings[k] = v;
  }
  state.prices = (await state.repo.getSetting('prices', {})) ?? {};
  state.logos = (await state.repo.getSetting('tickerLogos', {})) ?? {};
  state.highs = (await state.repo.getSetting('priceHighs', {})) ?? {};
}

export async function refresh() {
  state.trades = await state.repo.listTrades();
  state.log = await state.repo.activityLog();
}

export function applyTheme() {
  const t = state.settings.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const [name = 'home', param] = (location.hash.slice(1) || 'home').split('/');
  state.route = { name, params: { id: param } };
}

export function go(hash) {
  location.hash = hash;
}

async function refreshRoutePrice() {
  if (state.route.name !== 'trade') return;
  const t = state.trades.find((x) => x.id === state.route.params.id);
  if (!t || t.status !== 'OPEN') return;
  await refreshPrice(t.ticker, { repaint: true });
}

/* ------------------------------------------------------------------ */
/* Derived views                                                       */
/* ------------------------------------------------------------------ */

export const openTrades = () => state.trades.filter((t) => t.status === 'OPEN');
export const closedTrades = () => state.trades.filter((t) => t.status === 'CLOSED');
export const summaries = () => state.trades.map((t) => tradeSummary(t));
export const priceFor = (ticker) => state.prices[ticker] ?? null;
export const logoFor = (ticker) => state.logos[ticker]?.url ?? null;
export const rule = (tradeOrKey) => {
  const trade = typeof tradeOrKey === 'object' ? tradeOrKey : null;
  const base = resolveRule(trade?.rule ?? tradeOrKey, state.settings);
  return trade?.managementMode === 'trailing' ? withTradeTrailing(base, trade) : base;
};

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export function toast(message) {
  state.toast = message;
  render();
  setTimeout(() => {
    if (state.toast === message) {
      state.toast = null;
      render();
    }
  }, 2600);
}

export function haptic(ms = 12) {
  navigator.vibrate?.(ms);
}

export async function setSetting(key, value) {
  state.settings[key] = value;
  await state.repo.setSetting(key, value);
}

/** Manual prices intentionally carry no fabricated daily comparison. */
export async function setPrice(ticker, value, source = 'manual') {
  state.prices[ticker] = {
    price: value,
    at: new Date().toISOString(),
    source,
    previousClose: null,
    change: null,
    dailyPercent: null,
  };
  for (const trade of openTrades().filter((t) => t.ticker === ticker)) {
    state.highs[trade.id] = Math.max(state.highs[trade.id] ?? trade.entryPrice, value);
  }
  await state.repo.setSetting('prices', state.prices);
  await state.repo.setSetting('priceHighs', state.highs);
}

function sourceLabel(provider) {
  if (provider === 'twelve') return 'Twelve Data';
  if (provider === 'yahoo') return 'Yahoo';
  if (provider === 'stooq') return 'Stooq';
  return provider || 'market data';
}

async function ensureLogo(ticker) {
  const symbol = String(ticker ?? '').trim().toUpperCase();
  if (!symbol || state.logos[symbol] || !getTwelveDataKey()) return state.logos[symbol]?.url ?? null;
  const url = await fetchLogo(symbol);
  // Cache failures too. A missing logo should not cost another API credit every refresh.
  state.logos[symbol] = { url: url || null, checkedAt: new Date().toISOString() };
  await state.repo.setSetting('tickerLogos', state.logos);
  return url;
}

async function saveQuote(ticker, q) {
  state.prices[ticker] = {
    price: q.price,
    at: new Date().toISOString(),
    source: sourceLabel(q.provider),
    previousClose: q.previousClose ?? null,
    change: q.change ?? null,
    dailyPercent: q.dailyPercent ?? null,
    quoteDate: q.date ?? null,
    quoteDatetime: q.datetime ?? null,
    name: q.name ?? null,
    exchange: q.exchange ?? null,
    open: q.open ?? null,
    high: q.high ?? null,
    low: q.low ?? null,
    volume: q.volume ?? null,
    averageVolume: q.averageVolume ?? null,
    isMarketOpen: q.isMarketOpen ?? null,
    fiftyTwoWeek: q.fiftyTwoWeek ?? null,
  };
  for (const trade of openTrades().filter((t) => t.ticker === ticker)) {
    state.highs[trade.id] = Math.max(state.highs[trade.id] ?? trade.entryPrice, q.price);
  }
  await state.repo.setSetting('prices', state.prices);
  await state.repo.setSetting('priceHighs', state.highs);
  await ensureLogo(ticker);
}

/** Fetch one on-demand snapshot. Failure is intentionally silent. */
export async function refreshPrice(ticker, { repaint = false } = {}) {
  const symbol = String(ticker ?? '').trim().toUpperCase();
  if (!symbol) return null;
  try {
    const q = await fetchQuote(symbol, { providers: defaultProviders() });
    await saveQuote(symbol, q);
    if (repaint) render();
    return state.prices[symbol];
  } catch {
    return null;
  }
}

const PRICE_DRAFT_KEY = 'trade-journal:price-sheet';

function loadPriceSheetDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRICE_DRAFT_KEY) ?? 'null');
    if (saved?.open && Array.isArray(saved.tickers)) state.priceSheet = saved;
  } catch {
    localStorage.removeItem(PRICE_DRAFT_KEY);
  }
}

function persistPriceSheet() {
  if (state.priceSheet) localStorage.setItem(PRICE_DRAFT_KEY, JSON.stringify(state.priceSheet));
  else localStorage.removeItem(PRICE_DRAFT_KEY);
}

export function openPriceSheet(tickers = null) {
  const list = tickers?.length ? tickers : [...new Set(openTrades().map((t) => t.ticker))];
  const saved = state.priceSheet?.values ?? {};
  state.priceSheet = {
    open: true,
    tickers: list,
    values: Object.fromEntries(list.map((ticker) => [ticker, saved[ticker] ?? state.prices[ticker]?.price ?? ''])),
  };
  persistPriceSheet();
  render();
}

function priceSheet() {
  if (!state.priceSheet?.open) return '';
  return `<div class="sheet-backdrop">
    <section class="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="price-sheet-title">
      <div class="sheet-handle"></div>
      <div class="card-head">
        <div>
          <span class="label">Manual fallback</span>
          <h2 id="price-sheet-title">Update prices</h2>
        </div>
        <button class="chip" data-action="closePriceSheet" aria-label="Close">✕</button>
      </div>
      <p class="muted sheet-copy">Values are saved while you type. You can switch to another app and come back.</p>
      <div class="price-grid">
        ${state.priceSheet.tickers
          .map((ticker) => `<label class="price-row">
            <span class="ticker">${ticker}</span>
            <input inputmode="decimal" data-price-input="${ticker}" value="${state.priceSheet.values[ticker] ?? ''}"
                   placeholder="Last price">
            <span class="muted">Previous ${state.prices[ticker]?.price ?? '—'}</span>
          </label>`)
          .join('')}
      </div>
      <button class="btn primary sheet-save" data-action="savePriceSheet">Save prices</button>
    </section>
  </div>`;
}

export async function createTrade(meta, openEvent) {
  const trade = await state.repo.createTrade(meta, openEvent);
  await refresh();
  haptic(18);
  return trade;
}

export async function append(tradeId, ev, message) {
  try {
    await state.repo.appendEvent(tradeId, ev);
    await refresh();
    haptic();
    if (message) toast(message);
    else render();
  } catch (err) {
    toast(err.message);
  }
}

export const ev = E;

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

const SCREENS = {
  home: { title: 'Today', render: renderHome },
  new: { title: 'New trade', render: renderNewTrade },
  trades: { title: 'Trades', render: renderTrades },
  trade: { title: '', render: renderTradeDetail },
  log: { title: 'Log', render: renderLog },
  stats: { title: 'Stats', render: renderStats },
  settings: { title: 'Settings', render: renderSettings },
};

const TABS = [
  { id: 'home', glyph: '◧', label: 'Today' },
  { id: 'trades', glyph: '≡', label: 'Trades' },
  { id: 'new', glyph: '+', label: '', cls: 'new' },
  { id: 'log', glyph: '⋮', label: 'Log' },
  { id: 'stats', glyph: '◔', label: 'Stats' },
];

function tabs() {
  const active = state.route.name === 'trade' ? 'trades' : state.route.name;
  return `<nav class="tabs">${TABS.map(
    (t) => `<button class="${t.cls ?? ''}" data-go="${t.id}" ${
      active === t.id ? 'aria-current="page"' : ''
    } aria-label="${t.label || 'New trade'}">
        <span class="glyph">${t.glyph}</span>${t.label ? `<span>${t.label}</span>` : ''}
      </button>`
  ).join('')}</nav>`;
}

export function render() {
  const screen = SCREENS[state.route.name] ?? SCREENS.home;
  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="topbar">
      <h1>${screen.title || ''}</h1>
      <button class="chip" data-go="settings" aria-label="Settings">⚙</button>
    </header>
    <main class="screen">${screen.render(state)}</main>
    ${tabs()}
    ${priceSheet()}
    ${state.toast ? `<div class="toast" role="status">${state.toast}</div>` : ''}
  `;
  app.querySelector('.screen')?.scrollTo?.(0, 0);
}

let ticking = false;
window.addEventListener(
  'scroll',
  () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      document.body.classList.toggle('scrolled', window.scrollY > 4);
      ticking = false;
    });
  },
  { passive: true }
);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('[data-go][tabindex]');
  if (!el) return;
  e.preventDefault();
  go(el.dataset.go);
});

const PRICE_SENSITIVE_ACTIONS = new Set(['raiseStop', 'trim', 'addShares', 'closeTrade']);

document.addEventListener('click', async (e) => {
  const goEl = e.target.closest('[data-go]');
  if (goEl) {
    go(goEl.dataset.go);
    return;
  }
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const action = actionEl.dataset.action;
    const handler = ACTIONS[action];
    if (!handler) return;
    if (PRICE_SENSITIVE_ACTIONS.has(action) && actionEl.dataset.id) {
      const trade = state.trades.find((t) => t.id === actionEl.dataset.id);
      if (trade?.status === 'OPEN') await refreshPrice(trade.ticker);
    }
    handler(actionEl, e);
  }
});

document.addEventListener('input', (e) => {
  const priceInput = e.target.closest?.('[data-price-input]');
  if (priceInput && state.priceSheet) {
    state.priceSheet.values[priceInput.dataset.priceInput] = priceInput.value;
    persistPriceSheet();
  }
  const el = e.target.closest('[data-live]');
  if (el) LIVE[el.dataset.live]?.(el);
});

export { ACTIONS, LIVE };

ACTIONS.openPriceSheet = (el) => openPriceSheet(el.dataset.ticker ? [el.dataset.ticker] : null);
ACTIONS.closePriceSheet = () => {
  state.priceSheet = null;
  persistPriceSheet();
  render();
};
ACTIONS.savePriceSheet = async () => {
  if (!state.priceSheet) return;
  let saved = 0;
  for (const ticker of state.priceSheet.tickers) {
    const value = Number.parseFloat(state.priceSheet.values[ticker]);
    if (Number.isFinite(value) && value > 0) {
      await setPrice(ticker, value, 'manual');
      saved += 1;
    }
  }
  state.priceSheet = null;
  persistPriceSheet();
  toast(saved ? `Saved ${saved} price${saved === 1 ? '' : 's'}` : 'No prices entered');
};

/* ------------------------------------------------------------------ */
/* Price snapshots                                                     */
/* ------------------------------------------------------------------ */

/**
 * Explicit multi-symbol refresh. This is invoked by the Update prices button;
 * there is no boot refresh, interval or stream.
 */
export async function syncPrices({ tickers = null, manualFallback = false, showProgress = false } = {}) {
  const list = tickers?.length ? [...new Set(tickers)] : [...new Set(openTrades().map((t) => t.ticker))];
  if (!list.length) return null;

  if (showProgress) {
    state.priceSync = { running: true, done: 0, total: list.length, ticker: list[0] };
    render();
  }

  const results = await updatePrices(list, {
    providers: defaultProviders(),
    onProgress: (p) => {
      if (!showProgress) return;
      state.priceSync = { running: p.phase !== 'done', ...p };
      render();
    },
  });

  for (const q of results.updated) await saveQuote(q.ticker, q);

  state.priceSync = null;
  if (manualFallback && results.failed.length) openPriceSheet(results.failed.map((x) => x.ticker));
  else if (showProgress) toast(summarize(results));
  else render();
  return results;
}
