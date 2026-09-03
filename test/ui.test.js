/**
 * Render smoke tests.
 *
 * The UI modules are pure string builders plus a handful of DOM handlers, so a
 * minimal stub is enough to prove that every screen renders — including the
 * cases most likely to be reached first and to have been thought about least:
 * an empty journal, a trade with no price, and a period with no data.
 *
 * This will not catch a layout mistake. It will catch every crash, and a crash
 * is the failure that makes a screen unreachable.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../src/core/events.js';
import { MemoryStore } from '../src/data/store.js';
import { Repository } from '../src/data/repo.js';
import { tradeSummary } from '../src/core/metrics.js';

/* ---- the smallest DOM the modules touch at import time ---- */
const noop = () => {};
globalThis.document = {
  addEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ click: noop, style: {}, setAttribute: noop }),
  documentElement: { setAttribute: noop, removeAttribute: noop },
};
globalThis.window = { prompt: () => null, confirm: () => false, addEventListener: noop };
globalThis.location = { hash: '' };
// Node 22 exposes `navigator` as a getter-only global, so it has to be replaced
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { vibrate: noop, clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

const { state } = await import('../src/ui/app.js');
const { renderHome } = await import('../src/ui/screens/home.js');
const { renderNewTrade, calc } = await import('../src/ui/screens/newTrade.js');
const { renderTrades } = await import('../src/ui/screens/trades.js');
const { renderTradeDetail } = await import('../src/ui/screens/tradeDetail.js');
const { renderLog } = await import('../src/ui/screens/log.js');
const { renderStats } = await import('../src/ui/screens/stats.js');
const { renderSettings } = await import('../src/ui/screens/settings.js');
const { rail, rval, price, dollars, pct, DASH } = await import('../src/ui/format.js');

const D = (d) => `2026-08-${String(d).padStart(2, '0')}T15:35:00Z`;

async function seed({ withPrice = true } = {}) {
  state.repo = new Repository(new MemoryStore());
  state.prices = {};
  state.draft = {};
  state.route = { name: 'home', params: {} };
  state.priceSync = null;
  state.settings = {
    equity: 50000, riskPct: 1, defaultRule: 'ladderClassic', theme: 'system',
    autoPrices: true, trailType: 'TRAIL_PCT', trailValue: 8,
  };

  const a = await state.repo.createTrade(
    { ticker: 'DELL', setup: 'Breakout', entryEmotion: 'Calm', rule: 'ladderClassic', thesis: 'Base breakout' },
    E.open(D(3), { price: 100, qty: 100, stop: 95 })
  );
  await state.repo.appendEvent(a.id, E.stopChange(D(5), { to: 100, reason: 'structure', source: 'rule' }));
  await state.repo.appendEvent(a.id, E.ruleOverride(D(6), { ruleStop: 110, reason: 'gap fill' }));

  const b = await state.repo.createTrade(
    { ticker: 'JPM', setup: 'Pullback', entryEmotion: 'FOMO' },
    E.open(D(4), { price: 50, qty: 100, stop: 47 })
  );
  await state.repo.appendEvent(b.id, E.close(D(7), { price: 47, reason: 'Stop hit' }));

  if (withPrice) state.prices.DELL = { price: 112, at: D(8), source: 'manual' };
  state.trades = await state.repo.listTrades();
  state.log = await state.repo.activityLog();
  return { a, b };
}

const renders = (html) => {
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 0, 'produced no output');
  assert.ok(!html.includes('undefined'), 'leaked "undefined" into the markup');
  assert.ok(!html.includes('NaN'), 'leaked "NaN" into the markup');
  assert.ok(!html.includes('[object Object]'), 'leaked an object into the markup');
  return html;
};

describe('every screen renders with data', () => {
  before(() => seed());

  test('home', () => {
    const html = renders(renderHome(state));
    assert.match(html, /DELL/);
    assert.match(html, /At risk/);
    assert.match(html, /\+2\.40R/, 'DELL at 112 on a 5-point risk is +2.4R');
  });

  test('home surfaces the stop rule when it is triggered', () => {
    // Highest close 112 is 2.4R, so the ladder wants the stop at 1R = 105.
    const html = renderHome(state);
    assert.match(html, /Your rule says/);
    assert.match(html, /105\.00/);
    assert.match(html, /2R &rarr; 1R|2R → 1R/);
  });

  test('home shows what R is worth in dollars', () => {
    const html = renderHome(state);
    assert.match(html, />1R</, 'the R label');
    assert.match(html, /\$500/, 'DELL risks $5 x 100 shares');
    assert.match(html, /Open P&amp;L/);
  });

  test('home shows percent change from the entry', () => {
    // Entry 100, price 112.
    assert.match(renderHome(state), /\+12\.00%/);
  });

  test('a protected trade shows what is locked in rather than what is at risk', () => {
    // The stop was raised to 100, which is the entry.
    const html = renderHome(state);
    assert.match(html, /Locked in/);
    assert.ok(!/At risk<\/span>/.test(html.split('DELL')[1] ?? ''), 'not both at once');
  });

  test('price age is shown beside the price', () => {
    assert.match(renderHome(state), /stamp-age/);
  });

  test('the sync bar appears only while a fetch is running', () => {
    assert.ok(!renderHome(state).includes('sync-fill'));
    state.priceSync = { running: true, done: 1, total: 3, ticker: 'DELL' };
    const html = renderHome(state);
    assert.match(html, /sync-fill/);
    assert.match(html, /Fetching DELL/);
    assert.match(html, /1\/3/);
    state.priceSync = null;
  });

  test('trades list', () => {
    const html = renders(renderTrades(state));
    assert.match(html, /Open · 1/);
    assert.match(html, /Closed · 1/);
  });

  test('trades list shows percent change beside the R result', () => {
    const html = renderTrades(state);
    assert.match(html, /\+12\.00%/, 'DELL open: entry 100, price 112');
    assert.match(html, /-6\.00%/, 'JPM closed: entry 50, exit 47');
    assert.match(html, /-1\.00R/, 'and the R alongside it');
    assert.match(html, /-\$300/, 'and the dollars');
  });

  test('an open trade with no price shows a dash for the move, not zero', async () => {
    const saved = state.prices;
    state.prices = {};
    const html = renderTrades(state);
    assert.ok(!html.includes('+0.00%'));
    state.prices = saved;
  });

  test('trade detail, open', () => {
    state.route = { name: 'trade', params: { id: state.trades.find((t) => t.ticker === 'DELL').id } };
    const html = renders(renderTradeDetail(state));
    assert.match(html, /Stop history/);
    assert.match(html, /Raise to 105\.00/);
    assert.match(html, /1 rule override/);
    assert.match(html, /Base breakout/);
  });

  test('trade detail, closed', () => {
    state.route = { name: 'trade', params: { id: state.trades.find((t) => t.ticker === 'JPM').id } };
    const html = renders(renderTradeDetail(state));
    assert.match(html, /-1\.00R/);
    assert.match(html, /Stop hit/);
    assert.ok(!html.includes('Raise stop'), 'a closed trade offers no management actions');
  });

  test('log', () => {
    const html = renders(renderLog(state));
    assert.match(html, /skipped the rule, which said 110\.00/);
    assert.match(html, /stop 95\.00 → 100\.00 \(by rule\)/);
  });

  test('stats', () => {
    const html = renders(renderStats(state));
    assert.match(html, /Copy week/);
    assert.match(html, /By month/);
  });

  test('settings', () => {
    const html = renders(renderSettings(state));
    assert.match(html, /Backup/);
    assert.match(html, /50000/);
    assert.match(html, /Trailing stop/);
    assert.match(html, /then trail 8%/, 'the configured value is shown, not a placeholder');
    assert.match(html, /Fetch prices when the app opens/);
  });

  test('new trade', () => {
    renders(renderNewTrade(state));
  });
});

describe('empty and partial states', () => {
  beforeEach(async () => {
    state.repo = new Repository(new MemoryStore());
    state.trades = [];
    state.log = [];
    state.prices = {};
    state.draft = {};
    state.priceSync = null;
    state.settings = {
      equity: 50000, riskPct: 1, defaultRule: 'ladderClassic', theme: 'system',
      autoPrices: true, trailType: 'TRAIL_PCT', trailValue: 8,
    };
  });

  test('a brand new journal invites an action instead of showing zeroes', () => {
    const html = renders(renderHome(state));
    assert.match(html, /Add your first trade/);
    assert.ok(!html.includes('0.00R'));
  });

  test('stats before any trade closes says so', () => {
    assert.match(renders(renderStats(state)), /Stats appear once trades are closed/);
  });

  test('an empty log says so', () => {
    assert.match(renders(renderLog(state)), /Nothing has happened yet/);
  });

  test('an open trade with no price renders dashes, not zeroes', async () => {
    await seed({ withPrice: false });
    const html = renders(renderHome(state));
    assert.match(html, /No price yet/);
    assert.match(html, new RegExp(DASH));
  });

  test('trade detail survives a missing price', async () => {
    await seed({ withPrice: false });
    state.route = { name: 'trade', params: { id: state.trades.find((t) => t.ticker === 'DELL').id } };
    const html = renders(renderTradeDetail(state));
    assert.match(html, /Add a price to see where the rule puts your stop/);
  });

  test('a deleted trade id does not crash the detail screen', async () => {
    await seed();
    state.route = { name: 'trade', params: { id: 'gone' } };
    assert.match(renderTradeDetail(state), /no longer exists/);
  });
});

describe('the new-trade calculation', () => {
  const settings = { equity: 50000, riskPct: 1 };

  test('nothing to show until both prices exist', () => {
    assert.equal(calc({ entry: '100', stop: '' }, settings).ready, false);
    assert.equal(calc({ entry: '', stop: '95' }, settings).ready, false);
  });

  test('a stop above entry is refused in plain language', () => {
    const c = calc({ entry: '100', stop: '105' }, settings);
    assert.equal(c.ready, false);
    assert.match(c.error, /below entry/);
  });

  test('targets and risk per share', () => {
    const c = calc({ entry: '100', stop: '95', qty: '' }, settings);
    assert.equal(c.rps, 5);
    assert.equal(c.r1, 105);
    assert.equal(c.r2, 110);
    assert.equal(c.r3, 115);
    assert.equal(c.stopPct, 0.05);
  });

  test('suggested size comes from the risk setting', () => {
    assert.equal(calc({ entry: '100', stop: '95' }, settings).suggestedQty, 100, '$500 / $5');
  });

  test('actual risk once a size is entered', () => {
    const c = calc({ entry: '100', stop: '95', qty: '42' }, settings);
    assert.equal(c.risk, 210);
    assert.equal(c.riskPct, 0.0042);
    assert.equal(c.positionValue, 4200);
  });

  test('the panel warns when the size exceeds the risk setting', () => {
    state.settings = { ...settings, riskPct: 1, defaultRule: 'ladderClassic', theme: 'system', trailType: 'TRAIL_PCT', trailValue: 8 };
    state.draft = { new: { ticker: 'X', entry: '100', stop: '95', qty: '300', rule: 'ladderClassic' } };
    assert.match(renderNewTrade(state), /class="num r warn"/);
  });
});

describe('formatting refuses to fabricate', () => {
  test('missing values are dashes', () => {
    for (const f of [rval, price, dollars, pct]) {
      assert.equal(f(null), DASH);
      assert.equal(f(undefined), DASH);
      assert.equal(f(NaN), DASH);
    }
  });

  test('R always carries its sign', () => {
    assert.equal(rval(1.5), '+1.50R');
    assert.equal(rval(-1.5), '-1.50R');
    assert.equal(rval(0), '+0.00R');
  });

  test('sub-dollar names get more decimal places', () => {
    assert.equal(price(0.485), '0.485');
    assert.equal(price(471), '471.00');
  });
});

describe('the R rail', () => {
  const base = { entry: 100, stop: 95, activeStop: 95, riskPerShare: 5 };

  test('places entry, stop and both milestones', () => {
    const html = rail({ ...base, current: 108 });
    assert.match(html, />entry</);
    assert.match(html, />stop</);
    assert.match(html, />1R</);
    assert.match(html, />2R</);
    assert.match(html, /rail-now/);
  });

  test('the fill takes the colour of the direction', () => {
    assert.match(rail({ ...base, current: 108 }), /rail-fill pos/);
    assert.match(rail({ ...base, current: 97 }), /rail-fill neg/);
  });

  test('no current price means no marker, but the axis still draws', () => {
    const html = rail({ ...base, current: undefined });
    assert.ok(!html.includes('rail-now'));
    assert.match(html, /rail-track/);
  });

  test('the scale does not collapse when a trade runs past 2R', () => {
    const html = rail({ ...base, current: 140 });
    assert.match(html, />2R</, 'the 2R tick stays on the rail');
    const positions = [...html.matchAll(/left:([\d.]+)%/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...positions) <= 100, 'nothing is placed off the end');
  });

  test('a raised stop moves the stop tick, not the entry', () => {
    const html = rail({ ...base, activeStop: 104, current: 110 });
    assert.match(html, /rail-tick stop/);
    assert.match(html, /rail-tick entry/);
  });

  test('degenerate input renders nothing rather than a broken axis', () => {
    assert.equal(rail({ entry: 100, stop: 100, riskPerShare: 0 }), '');
    assert.equal(rail({ entry: null, stop: 95, riskPerShare: 5 }), '');
  });
});
