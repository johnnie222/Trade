/**
 * Trade detail.
 *
 * The command centre for one trade. Numbers first, then the rule, then the
 * timeline, then the actions. Every action is one tap to reach and appends an
 * event — there is no edit-and-save model, because a journal that lets you
 * quietly rewrite the past is not a journal.
 */

import { ACTIONS } from '../registry.js';
import { state, priceFor, append, ev, rule, toast, go, refresh, setPrice } from '../app.js';
import {
  currentR,
  realizedR,
  openRisk,
  lockedIn,
  isProtected,
  priceAtR,
  tradeStatusLabel,
} from '../../core/engine.js';
import { evaluateStopRule, PRESETS } from '../../core/stopRules.js';
import { rail, rval, dollars, price as fmtPrice, pct, tone, dayAndTime, shortDate, daysBetween, esc } from '../format.js';

const EXIT_REASONS = [
  'Target reached', 'Stop hit', 'Structure broken', 'Failed breakout',
  'Resistance rejection', 'Trailing stop', 'Event risk', 'Mistake', 'Other',
];

const find = (id) => state.trades.find((t) => t.id === id);

function rulePanel(t, p) {
  if (!t.rule || t.rule === 'discretionary') return '';
  const preset = rule(t.rule);
  if (!p) {
    return `<div class="card"><span class="label">Stop rule</span>
      <p style="margin:var(--sp-2) 0 0">${esc(preset.label)}</p>
      <p class="muted" style="margin:var(--sp-1) 0 0">Add a price to see where the rule puts your stop.</p></div>`;
  }

  const r = evaluateStopRule(preset, {
    entryPrice: t.entryPrice,
    riskPerShare: t.riskPerShare,
    activeStop: t.activeStop,
    highestClose: p.price,
    currentPrice: p.price,
  });

  if (!r.shouldRaise) {
    return `<div class="card"><span class="label">Stop rule</span>
      <p style="margin:var(--sp-2) 0 0">${esc(preset.label)}</p>
      <p class="muted" style="margin:var(--sp-1) 0 0">
        ${r.ruleStop == null ? 'Not triggered yet.' : 'Nothing to raise — your stop is already at or above it.'}
      </p></div>`;
  }

  return `
    <div class="card" style="border-color:var(--warn)">
      <div class="card-head">
        <span class="label warn">Stop rule</span>
        <span class="pill warn">${esc(r.triggeredBy)}</span>
      </div>
      <p style="margin:0">Your stop is <span class="num">${fmtPrice(t.activeStop)}</span>.
         The rule says <span class="num r">${fmtPrice(r.target)}</span>.</p>
      ${
        r.breached
          ? '<p class="warn" style="margin:var(--sp-2) 0 0">That is at or above the last price — the rule says you should already be out.</p>'
          : ''
      }
      <div class="btn-row" style="margin-top:var(--sp-3)">
        <button class="btn primary" data-action="applyRule" data-id="${t.id}" data-stop="${r.target}">
          Raise to ${fmtPrice(r.target)}
        </button>
        <button class="btn" data-action="skipRule" data-id="${t.id}" data-stop="${r.target}">Skip</button>
      </div>
    </div>`;
}

const EVENT_LINE = {
  OPEN: (p) => `Opened ${p.qty} @ ${fmtPrice(p.price)}, stop ${fmtPrice(p.stop)}`,
  ADD: (p) => `Added ${p.qty} @ ${fmtPrice(p.price)}`,
  TRIM: (p) => `Trimmed ${p.qty} @ ${fmtPrice(p.price)}`,
  STOP_CHANGE: (p) =>
    `Stop ${fmtPrice(p.from)} → ${fmtPrice(p.to)}${p.source === 'rule' ? ' (by rule)' : ''}`,
  RULE_OVERRIDE: (p) => `Skipped the rule, which said ${fmtPrice(p.ruleStop)}`,
  SPLIT: (p) => `${p.numerator}:${p.denominator} split applied`,
  NOTE: (p) => esc(p.text),
  CLOSE: (p) => `Closed @ ${fmtPrice(p.price)}`,
  TRADE_EDIT: (p) => `Corrected ${p.field}: ${p.from} → ${p.to}`,
};

const EVENT_CLASS = { RULE_OVERRIDE: 'skip', CLOSE: 'exit', STOP_CHANGE: 'rule' };

function timeline(t) {
  const rows = [...t.events].reverse();
  return `<div class="timeline">${rows
    .map((e) => {
      const p = { ...e.payload };
      // `from` is derived, so fill it for display from the stop history.
      if (e.type === 'STOP_CHANGE') {
        p.from = t.stopHistory.find((h) => h.at === e.at && h.to === p.to)?.from ?? p.from;
      }
      return `<div class="tl-item ${EVENT_CLASS[e.type] ?? ''}">
        <div class="tl-when">${dayAndTime(e.at)}</div>
        <div class="tl-what">${EVENT_LINE[e.type]?.(p) ?? e.type}</div>
        ${p.reason ? `<div class="tl-why">${esc(p.reason)}</div>` : ''}
        ${e.note ? `<div class="tl-why">${esc(e.note)}</div>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

export function renderTradeDetail(s) {
  const t = find(s.route.params.id);
  if (!t) return '<div class="empty-state"><p>That trade no longer exists.</p></div>';

  const p = priceFor(t.ticker);
  const isOpen = t.status === 'OPEN';
  const r = isOpen ? (p ? currentR(t, p.price) : null) : realizedR(t);

  return `
    <section class="card">
      <div class="card-head">
        <span class="ticker" style="font-size:var(--step-2)">${esc(t.ticker)}</span>
        <span class="pill ${isOpen ? '' : 'muted'}">${isOpen ? (p ? tradeStatusLabel(t, p.price) : 'Open') : 'Closed'}</span>
      </div>
      <div class="r big ${tone(r)}">${rval(r)}</div>
      <p class="muted" style="margin:var(--sp-1) 0 0">
        ${esc(t.setup ?? 'Untagged')} · ${
    isOpen ? `day ${daysBetween(t.openedAt)}` : `${daysBetween(t.openedAt, t.closedAt)} days`
  } · 1R = ${dollars(t.R, { sign: false })}
      </p>

      ${rail({
        entry: t.entryPrice,
        stop: t.initialStop,
        activeStop: t.activeStop,
        current: isOpen ? p?.price : t.exitPrice,
        riskPerShare: t.riskPerShare,
      })}

      <div class="kv">
        <div><span class="label">Entry</span><span class="num">${fmtPrice(t.entryPrice)}</span></div>
        <div><span class="label">Initial stop</span><span class="num">${fmtPrice(t.initialStop)}</span></div>
        <div><span class="label">Active stop</span><span class="num ${isProtected(t) ? 'pos' : ''}">${fmtPrice(
    t.activeStop
  )}</span></div>
        <div><span class="label">1R</span><span class="num">${fmtPrice(priceAtR(t, 1))}</span></div>
        <div><span class="label">2R</span><span class="num">${fmtPrice(priceAtR(t, 2))}</span></div>
      </div>

      <div class="kv" style="border-top:1px solid var(--border);margin-top:var(--sp-3);padding-top:var(--sp-3)">
        <div><span class="label">${isOpen ? 'Shares' : 'Exit'}</span><span class="num">${
    isOpen ? t.qty : fmtPrice(t.exitPrice)
  }</span></div>
        <div><span class="label">Realized</span><span class="num r ${tone(realizedR(t))}">${rval(
    realizedR(t)
  )}</span></div>
        ${
          isOpen
            ? `<div><span class="label">Open risk</span><span class="num">${
                openRisk(t) > 0 ? dollars(openRisk(t), { sign: false }) : '<span class="pos">none</span>'
              }</span></div>
               <div><span class="label">Locked in</span><span class="num ${tone(lockedIn(t))}">${dollars(
                lockedIn(t)
              )}</span></div>`
            : `<div><span class="label">P&amp;L</span><span class="num ${tone(t.realizedPnl)}">${dollars(
                t.realizedPnl
              )}</span></div>
               <div><span class="label">Reason</span><span class="muted">${esc(t.exitReason ?? '—')}</span></div>`
        }
      </div>

      ${
        isOpen
          ? `<div class="btn-row" style="margin-top:var(--sp-4)">
               <button class="chip" data-action="setPrice" data-id="${t.id}">
                 ${p ? `${fmtPrice(p.price)} · ${esc(p.source)}` : 'Add price'}
               </button>
             </div>`
          : ''
      }
    </section>

    ${isOpen ? rulePanel(t, p) : ''}

    ${
      t.thesis || t.invalidation
        ? `<div class="card">
            ${t.thesis ? `<span class="label">Thesis</span><p style="margin:var(--sp-1) 0 var(--sp-3)">${esc(t.thesis)}</p>` : ''}
            ${
              t.invalidation
                ? `<span class="label">Proves me wrong</span><p style="margin:var(--sp-1) 0 0">${esc(t.invalidation)}</p>`
                : ''
            }
          </div>`
        : ''
    }

    <div class="section-title"><span class="label">Stop history</span></div>
    <div class="card">
      <table>
        <tbody>
          ${t.stopHistory
            .map(
              (h) => `<tr>
                <td>${shortDate(h.at)}</td>
                <td class="num">${h.from == null ? 'initial' : fmtPrice(h.from) + ' →'}</td>
                <td class="num ${h.widened ? 'neg' : ''}">${fmtPrice(h.to)}</td>
                <td class="muted">${esc(h.reason ?? h.source)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
      ${
        t.ruleOverrides.length
          ? `<p class="muted" style="margin:var(--sp-3) 0 0">${t.ruleOverrides.length} rule override${
              t.ruleOverrides.length === 1 ? '' : 's'
            }: ${t.ruleOverrides.map((o) => esc(o.reason ?? 'no reason given')).join('; ')}</p>`
          : ''
      }
    </div>

    <div class="section-title"><span class="label">Timeline</span></div>
    <div class="card">${timeline(t)}</div>

    ${
      isOpen
        ? `<div class="btn-row" style="margin-top:var(--sp-4)">
            <button class="btn" data-action="raiseStop" data-id="${t.id}">Raise stop</button>
            <button class="btn" data-action="addNote" data-id="${t.id}">Note</button>
            <button class="btn" data-action="trim" data-id="${t.id}">Trim</button>
            <button class="btn primary" data-action="closeTrade" data-id="${t.id}">Close</button>
          </div>
          <div class="btn-row" style="margin-top:var(--sp-2)">
            <button class="chip" data-action="addShares" data-id="${t.id}">Add shares</button>
            <button class="chip" data-action="applySplit" data-id="${t.id}">Apply split</button>
          </div>`
        : `<div class="btn-row" style="margin-top:var(--sp-4)">
            <button class="btn" data-action="addLesson" data-id="${t.id}">${
            t.lesson ? 'Edit lesson' : 'Add a lesson'
          }</button>
          </div>
          ${t.lesson ? `<div class="card"><span class="label">Lesson</span><p style="margin:var(--sp-1) 0 0">${esc(t.lesson)}</p></div>` : ''}`
    }`;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const ask = (label, fallback = '') => window.prompt(label, fallback);
const askNum = (label, fallback = '') => {
  const v = ask(label, fallback);
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

ACTIONS.setPrice = async (el) => {
  const t = find(el.dataset.id);
  const current = priceFor(t.ticker)?.price ?? '';
  const v = askNum(`Last price for ${t.ticker}`, current);
  if (v == null || v <= 0) return;
  await setPrice(t.ticker, v, 'manual');
  toast(`${t.ticker} ${fmtPrice(v)}`);
};

ACTIONS.applyRule = async (el) => {
  const stop = Number.parseFloat(el.dataset.stop);
  await append(
    el.dataset.id,
    ev.stopChange(new Date().toISOString(), { to: stop, reason: 'stop rule', source: 'rule' }),
    `Stop raised to ${fmtPrice(stop)}`
  );
};

/**
 * Skipping is a first-class event, not a dismissal. The reason is asked for
 * once, at the moment the decision is made, and never asked for again — that
 * sentence is the most valuable thing in the weekly review.
 */
ACTIONS.skipRule = async (el) => {
  const reason = ask('Why are you keeping your stop where it is?', '');
  if (reason == null) return;
  await append(
    el.dataset.id,
    ev.ruleOverride(new Date().toISOString(), {
      ruleStop: Number.parseFloat(el.dataset.stop),
      reason: reason || null,
    }),
    'Recorded'
  );
};

ACTIONS.raiseStop = async (el) => {
  const t = find(el.dataset.id);
  const to = askNum('New stop', String(t.activeStop));
  if (to == null) return;
  const reason = ask('Why? (optional)', '') ?? null;
  const p = priceFor(t.ticker);
  await append(
    t.id,
    ev.stopChange(new Date().toISOString(), {
      to,
      reason: reason || null,
      source: 'manual',
      priceAtTime: p?.price ?? null,
    }),
    to < t.activeStop ? 'Stop widened — recorded' : `Stop → ${fmtPrice(to)}`
  );
};

ACTIONS.addNote = async (el) => {
  const text = ask('Note');
  if (!text) return;
  await append(el.dataset.id, ev.note(new Date().toISOString(), { text }), 'Noted');
};

ACTIONS.trim = async (el) => {
  const t = find(el.dataset.id);
  const qty = askNum(`Shares to sell (holding ${t.qty})`, String(Math.floor(t.qty / 2)));
  if (qty == null) return;
  const price = askNum('Fill price', String(priceFor(t.ticker)?.price ?? ''));
  if (price == null) return;
  await append(t.id, ev.trim(new Date().toISOString(), { price, qty }), `Trimmed ${qty}`);
};

ACTIONS.addShares = async (el) => {
  const t = find(el.dataset.id);
  const qty = askNum('Shares to add', '');
  if (qty == null) return;
  const price = askNum('Fill price', String(priceFor(t.ticker)?.price ?? ''));
  if (price == null) return;
  await append(t.id, ev.add(new Date().toISOString(), { price, qty }), `Added ${qty}`);
};

ACTIONS.applySplit = async (el) => {
  const input = ask('Split ratio, as new:old', '2:1');
  if (!input) return;
  const [numerator, denominator] = input.split(':').map(Number);
  if (!(numerator > 0) || !(denominator > 0)) return toast('Enter a ratio like 2:1');
  await append(
    el.dataset.id,
    ev.split(new Date().toISOString(), { numerator, denominator }),
    'Split applied — R is unchanged'
  );
};

ACTIONS.closeTrade = async (el) => {
  const t = find(el.dataset.id);
  const price = askNum(`Exit price for ${t.qty} shares`, String(priceFor(t.ticker)?.price ?? ''));
  if (price == null) return;
  const reason = ask(`Reason?\n${EXIT_REASONS.join(' · ')}`, 'Target reached');
  await append(
    t.id,
    ev.close(new Date().toISOString(), { price, reason: reason || null }),
    null
  );
  await setPrice(t.ticker, price, 'exit fill');
  const closed = find(t.id);
  toast(`${t.ticker} closed ${rval(realizedR(closed))}`);
};

ACTIONS.addLesson = async (el) => {
  const t = find(el.dataset.id);
  const lesson = ask('What did this trade teach you?', t.lesson ?? '');
  if (lesson == null) return;
  const record = await state.repo.store.get('trades', t.id);
  await state.repo.store.put('trades', { ...record, lesson });
  await refresh();
  toast('Saved');
};
