/**
 * App shell: state, routing and the actions every screen calls.
 *
 * Rendering is a plain function of state to an HTML string, re-run on change.
 * No framework, no build step, no dependency that can break offline. With a
 * handful of screens and no per-keystroke re-render this is faster to load and
 * far less to maintain than anything it would be replaced with.
 */

import { ACTIONS, LIVE } from './registry.js';
import { IdbStore, MemoryStore } from '../data/store.js';
import { Repository } from '../data/repo.js';
import { autoBackup } from '../data/browserBackup.js';
import * as E from '../core/events.js';
import { tradeSummary } from '../core/metrics.js';
import { resolveRule, withTradeTrailing } from '../core/stopRules.js';
import { updatePrices, shouldAutoUpdate, summarize } from '../data/marketData.js';

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
    autoPrices: true,
  },
  /** { running, done, total, ticker } while the price queue is working. */
  priceSync: null,
  /**
   * Last known price per ticker.
   *
   * Deliberately NOT in the event log. The log records decisions the trader
   * made; a quote is an observation about the market. Mixing the two would put
   * a row in the trade timeline every time a price refreshed, and would make
   * the "what did I do" feed unreadable. Prices live in settings under
   * `price:TICKER` and are replaced, never appended.
   */
  prices: {},
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
  });
  parseRoute();
  render();

  // Silent unless something is due. See browserBackup.js.
  autoBackup(state.repo).catch((err) => console.warn('Backup skipped', err));
  syncPrices({ auto: true }).catch((err) => console.warn('Price sync skipped', err));
}

async function loadSettings() {
  const keys = ['equity', 'riskPct', 'defaultRule', 'theme', 'autoPrices'];
  for (const k of keys) {
    const v = await state.repo.getSetting(k, state.settings[k]);
    if (v != null) state.settings[k] = v;
  }
  state.prices = (await state.repo.getSetting('prices', {})) ?? {};
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

/* ------------------------------------------------------------------ */
/* Derived views                                                       */
/* ------------------------------------------------------------------ */

export const openTrades = () => state.trades.filter((t) => t.status === 'OPEN');
export const closedTrades = () => state.trades.filter((t) => t.status === 'CLOSED');
export const summaries = () => state.trades.map((t) => tradeSummary(t));
export const priceFor = (ticker) => state.prices[ticker] ?? null;
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

export async function setPrice(ticker, value, source = 'manual') {
  state.prices[ticker] = { price: value, at: new Date().toISOString(), source };
  for (const trade of openTrades().filter((t) => t.ticker === ticker)) {
    state.highs[trade.id] = Math.max(state.highs[trade.id] ?? trade.entryPrice, value);
  }
  await state.repo.setSetting('prices', state.prices);
  await state.repo.setSetting('priceHighs', state.highs);
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
    // The repository rejects anything that would make the log unprojectable,
    // so this is where an impossible action surfaces as plain language.
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

/* The header rule appears only once there is content scrolled behind it. */
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

/* Cards and table rows navigate, so they must answer the keyboard too. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('[data-go][tabindex]');
  if (!el) return;
  e.preventDefault();
  go(el.dataset.go);
});

/* Event delegation. One listener per event type for the whole app. */
document.addEventListener('click', (e) => {
  const goEl = e.target.closest('[data-go]');
  if (goEl) {
    go(goEl.dataset.go);
    return;
  }
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const handler = ACTIONS[actionEl.dataset.action];
    if (handler) handler(actionEl, e);
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
/* Price sync                                                          */
/* ------------------------------------------------------------------ */

/**
 * Refresh every open ticker, once, in the background.
 *
 * On boot this runs automatically and silently: no spinner blocking the first
 * paint, no toast if it fails. The journal is fully usable without it, and an
 * error message about a price feed is not what anyone wants to see when they
 * open the app to check a position.
 *
 * Triggered by hand from the Home screen it is loud instead — progress while it
 * runs, and a result either way.
 */
export async function syncPrices({ auto = false } = {}) {
  const tickers = [...new Set(openTrades().map((t) => t.ticker))];
  if (!tickers.length) return null;

  if (auto) {
    const lastRunAt = await state.repo.getSetting('lastPriceSync', null);
    const decision = shouldAutoUpdate({ enabled: state.settings.autoPrices, lastRunAt });
    if (!decision.update) return null;
  }

  state.priceSync = { running: true, done: 0, total: tickers.length, ticker: tickers[0] };
  if (!auto) render();

  const results = await updatePrices(tickers, {
    onProgress: (p) => {
      state.priceSync = { running: p.phase !== 'done', ...p };
      if (!auto) render();
    },
  });

  for (const q of results.updated) {
    state.prices[q.ticker] = {
      price: q.price,
      at: new Date().toISOString(),
      source: `${q.provider === 'yahoo' ? 'Yahoo' : 'Stooq'}${q.date ? ` · ${q.date}` : ''}`,
    };
    for (const trade of openTrades().filter((t) => t.ticker === q.ticker)) {
      state.highs[trade.id] = Math.max(state.highs[trade.id] ?? trade.entryPrice, q.price);
    }
  }
  if (results.updated.length) {
    await state.repo.setSetting('prices', state.prices);
    await state.repo.setSetting('priceHighs', state.highs);
  }
  await state.repo.setSetting('lastPriceSync', new Date().toISOString());

  state.priceSync = null;
  if (auto) render();
  else if (results.failed.length) openPriceSheet(results.failed.map((x) => x.ticker));
  else toast(summarize(results));
  return results;
}
