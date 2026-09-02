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
import { PRESETS } from '../core/stopRules.js';

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
  },
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
}

async function loadSettings() {
  const keys = ['equity', 'riskPct', 'defaultRule', 'theme'];
  for (const k of keys) {
    const v = await state.repo.getSetting(k, state.settings[k]);
    if (v != null) state.settings[k] = v;
  }
  state.prices = (await state.repo.getSetting('prices', {})) ?? {};
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
export const rule = (key) => PRESETS[key] ?? PRESETS.discretionary;

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
  await state.repo.setSetting('prices', state.prices);
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
    ${state.toast ? `<div class="toast" role="status">${state.toast}</div>` : ''}
  `;
  app.querySelector('.screen')?.scrollTo?.(0, 0);
}

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
  const el = e.target.closest('[data-live]');
  if (el) LIVE[el.dataset.live]?.(el);
});

export { ACTIONS, LIVE };
