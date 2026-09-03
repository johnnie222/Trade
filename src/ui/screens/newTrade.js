/**
 * New trade. Four core fields, live calculation, one button.
 */

import { ACTIONS, LIVE } from '../registry.js';
import { state, createTrade, go, toast, ev, setPrice, refreshPrice } from '../app.js';
import { PRESETS } from '../../core/stopRules.js';
import { price as fmtPrice, dollars, pct, esc } from '../format.js';

const SETUPS = ['Breakout', 'Pullback', 'Support Bounce', 'Trend Continuation', 'Gap', 'Reversal', 'Base Breakout'];
const EMOTIONS = ['Calm', 'Confident', 'FOMO', 'Unsure'];
const ACTIVE_RULES = ['discretionary', 'ladderClassic'];

const activeRule = (key) => (ACTIVE_RULES.includes(key) ? key : 'ladderClassic');

const draft = () => (state.draft.new ??= {
  ticker: '',
  entry: '',
  stop: '',
  qty: '',
  setup: null,
  emotion: null,
  rule: activeRule(state.settings.defaultRule),
  thesis: '',
  invalidation: '',
});

const numOrNull = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function calc(d, settings) {
  const entry = numOrNull(d.entry);
  const stop = numOrNull(d.stop);
  const qty = numOrNull(d.qty);
  if (entry == null || stop == null) return { ready: false };
  if (stop >= entry) return { ready: false, error: 'Stop must be below entry.' };

  const rps = entry - stop;
  const maxRisk = (settings.equity * settings.riskPct) / 100;

  return {
    ready: true,
    entry,
    stop,
    qty,
    rps,
    stopPct: rps / entry,
    r1: entry + rps,
    r2: entry + rps * 2,
    r3: entry + rps * 3,
    risk: qty ? rps * qty : null,
    riskPct: qty && settings.equity ? (rps * qty) / settings.equity : null,
    positionValue: qty ? entry * qty : null,
    suggestedQty: Math.floor(maxRisk / rps),
    maxRisk,
  };
}

function calcPanel(c) {
  if (c.error) return `<div class="calc empty">${c.error}</div>`;
  if (!c.ready) return `<div class="calc empty">Enter an entry and a stop to see the risk.</div>`;

  return `
    <div class="calc">
      <div class="kv">
        <div><span class="label">Risk / share</span><span class="num">${dollars(c.rps, { sign: false })}</span></div>
        <div><span class="label">Stop distance</span><span class="num">${pct(c.stopPct, { dp: 2 })}</span></div>
        <div><span class="label">1R</span><span class="num">${fmtPrice(c.r1)}</span></div>
        <div><span class="label">2R</span><span class="num">${fmtPrice(c.r2)}</span></div>
        <div><span class="label">3R</span><span class="num">${fmtPrice(c.r3)}</span></div>
      </div>
      ${
        c.risk != null
          ? `<div class="kv" style="margin-top:var(--sp-4);border-top:1px solid var(--border);padding-top:var(--sp-3)">
              <div><span class="label">Risk (1R)</span><span class="num r ${
                c.riskPct > state.settings.riskPct / 100 ? 'warn' : ''
              }">${dollars(c.risk, { sign: false })}</span></div>
              <div><span class="label">Of account</span><span class="num">${pct(c.riskPct, { dp: 2 })}</span></div>
              <div><span class="label">Position</span><span class="num">${dollars(c.positionValue, { sign: false })}</span></div>
            </div>`
          : `<p class="muted" style="margin:var(--sp-3) 0 0">
               At ${state.settings.riskPct}% risk that is
               <button class="chip" data-action="useSuggested" data-qty="${c.suggestedQty}">${c.suggestedQty} shares</button>
             </p>`
      }
    </div>`;
}

export function renderNewTrade(s) {
  const d = draft();
  const c = calc(d, s.settings);

  return `
    <form id="new-trade" onsubmit="return false">
      <div class="field">
        <label class="label" for="f-ticker">Ticker</label>
        <input id="f-ticker" class="ticker" data-live="new" data-k="ticker" data-quote-ticker value="${esc(d.ticker)}"
               autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="DELL" enterkeyhint="next">
      </div>

      <div class="row">
        <div class="field">
          <label class="label" for="f-entry">Entry</label>
          <input id="f-entry" inputmode="decimal" data-live="new" data-k="entry" value="${esc(d.entry)}" placeholder="0.00">
        </div>
        <div class="field">
          <label class="label" for="f-stop">Initial stop</label>
          <input id="f-stop" inputmode="decimal" data-live="new" data-k="stop" value="${esc(d.stop)}" placeholder="0.00">
        </div>
      </div>

      <div class="field">
        <label class="label" for="f-qty">Shares</label>
        <input id="f-qty" inputmode="numeric" data-live="new" data-k="qty" value="${esc(d.qty)}" placeholder="0">
      </div>

      ${calcPanel(c)}

      <div class="field">
        <span class="label">How does this feel?</span>
        <div class="chips">
          ${EMOTIONS.map(
            (e) =>
              `<button type="button" class="chip" data-action="pick" data-k="emotion" data-v="${e}"
                       aria-pressed="${d.emotion === e}">${e}</button>`
          ).join('')}
        </div>
      </div>

      <div class="field">
        <label class="label" for="f-rule">Stop rule</label>
        <select id="f-rule" data-live="new" data-k="rule">
          ${Object.entries(PRESETS)
            .filter(([key]) => ACTIVE_RULES.includes(key))
            .map(([k, r]) => `<option value="${k}" ${d.rule === k ? 'selected' : ''}>${r.label}</option>`)
            .join('')}
        </select>
      </div>

      <details ${d.setup || d.thesis ? 'open' : ''}>
        <summary>Setup and thesis</summary>
        <div class="field">
          <span class="label">Setup</span>
          <div class="chips">
            ${SETUPS.map(
              (x) =>
                `<button type="button" class="chip" data-action="pick" data-k="setup" data-v="${x}"
                         aria-pressed="${d.setup === x}">${x}</button>`
            ).join('')}
          </div>
        </div>
        <div class="field">
          <label class="label" for="f-thesis">Why this trade</label>
          <textarea id="f-thesis" data-live="new" data-k="thesis" placeholder="What you expect to happen.">${esc(d.thesis)}</textarea>
        </div>
        <div class="field">
          <label class="label" for="f-inval">What proves you wrong</label>
          <textarea id="f-inval" data-live="new" data-k="invalidation"
                    placeholder="Not the stop price — the thing that kills the idea.">${esc(d.invalidation)}</textarea>
        </div>
      </details>

      <div class="btn-row" style="margin-top:var(--sp-5)">
        <button class="btn primary" data-action="openTrade" ${
          c.ready && d.ticker.trim() && numOrNull(d.qty) ? '' : 'disabled'
        }>Open trade</button>
      </div>
      ${
        c.ready && d.ticker.trim() && !numOrNull(d.qty)
          ? '<p class="muted" style="text-align:center">Add a share count to open.</p>'
          : ''
      }
    </form>`;
}

LIVE.new = (el) => {
  const d = draft();
  const k = el.dataset.k;
  d[k] = k === 'ticker' ? el.value.toUpperCase() : el.value;

  if (['entry', 'stop', 'qty'].includes(k)) {
    const c = calc(d, state.settings);
    document.querySelector('.calc')?.outerHTML && replaceCalc(c);
    const btn = document.querySelector('[data-action="openTrade"]');
    if (btn) btn.disabled = !(c.ready && d.ticker.trim() && numOrNull(d.qty));
  }
  if (k === 'ticker') {
    const btn = document.querySelector('[data-action="openTrade"]');
    const c = calc(d, state.settings);
    if (btn) btn.disabled = !(c.ready && d.ticker.trim() && numOrNull(d.qty));
  }
};

function replaceCalc(c) {
  const node = document.querySelector('.calc');
  if (!node) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = calcPanel(c);
  node.replaceWith(wrap.firstElementChild);
}

// Snapshot on ticker completion (change/blur), not on every keystroke.
document.addEventListener('change', async (e) => {
  const input = e.target.closest?.('[data-quote-ticker]');
  if (!input) return;
  const d = draft();
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;
  const quote = await refreshPrice(ticker);
  if (!quote || d.entry) return;
  // Do not overwrite an entry the user started typing while the request was in flight.
  d.entry = String(quote.price);
  const entry = document.getElementById('f-entry');
  if (entry && !entry.value) {
    entry.value = d.entry;
    LIVE.new(entry);
  }
});

ACTIONS.pick = (el) => {
  const d = draft();
  const k = el.dataset.k;
  d[k] = d[k] === el.dataset.v ? null : el.dataset.v;
  document
    .querySelectorAll(`[data-action="pick"][data-k="${k}"]`)
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === d[k])));
};

ACTIONS.useSuggested = (el) => {
  const d = draft();
  d.qty = el.dataset.qty;
  const input = document.getElementById('f-qty');
  if (input) input.value = d.qty;
  LIVE.new(input ?? { dataset: { k: 'qty' }, value: d.qty });
};

ACTIONS.openTrade = async () => {
  const d = draft();
  const c = calc(d, state.settings);
  const qty = numOrNull(d.qty);
  if (!c.ready || !qty || !d.ticker.trim()) return;

  try {
    const trade = await createTrade(
      {
        ticker: d.ticker.trim().toUpperCase(),
        setup: d.setup,
        entryEmotion: d.emotion,
        thesis: d.thesis || null,
        invalidation: d.invalidation || null,
        rule: d.rule,
      },
      ev.open(new Date().toISOString(), {
        price: c.entry,
        qty,
        stop: c.stop,
        rule: d.rule,
      })
    );
    await setPrice(trade.ticker, c.entry, 'entry fill');
    state.draft.new = null;
    go(`trade/${trade.id}`);
    toast(`${trade.ticker} opened · risk ${dollars(c.rps * qty, { sign: false })}`);
  } catch (err) {
    toast(err.message);
  }
};
