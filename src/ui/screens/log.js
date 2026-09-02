/**
 * The activity log.
 *
 * Everything that happened, newest first, across every trade. This is the
 * fastest way to answer "what did I actually do last Tuesday" without opening
 * six trades one at a time.
 */

import { ACTIONS } from '../registry.js';
import { state, render } from '../app.js';
import { price as fmtPrice, dayAndTime, esc } from '../format.js';

const TYPES = [
  ['', 'Everything'],
  ['STOP_CHANGE', 'Stops'],
  ['RULE_OVERRIDE', 'Skipped rules'],
  ['OPEN,CLOSE,TRIM,ADD', 'Fills'],
  ['NOTE,DAILY_NOTE', 'Notes'],
];

const LINE = {
  OPEN: (p) => `opened ${p.qty} @ ${fmtPrice(p.price)}, stop ${fmtPrice(p.stop)}`,
  ADD: (p) => `added ${p.qty} @ ${fmtPrice(p.price)}`,
  TRIM: (p) => `trimmed ${p.qty} @ ${fmtPrice(p.price)}`,
  STOP_CHANGE: (p) =>
    `stop ${fmtPrice(p.from)} → ${fmtPrice(p.to)}${p.source === 'rule' ? ' (by rule)' : ''}`,
  RULE_OVERRIDE: (p) => `skipped the rule, which said ${fmtPrice(p.ruleStop)}`,
  CLOSE: (p) => `closed @ ${fmtPrice(p.price)}`,
  NOTE: (p) => esc(p.text),
  DAILY_NOTE: (p) => esc(p.text),
  SPLIT: (p) => `${p.numerator}:${p.denominator} split`,
  TRADE_EDIT: (p) => `corrected ${p.field}: ${p.from} → ${p.to}`,
};

const CLS = { RULE_OVERRIDE: 'skip', CLOSE: 'exit', STOP_CHANGE: 'rule' };

export function renderLog(s) {
  const filter = s.draft.logFilter ?? '';
  const rows = filter ? s.log.filter((e) => filter.split(',').includes(e.type)) : s.log;

  if (!s.log.length) {
    return '<div class="empty-state"><p>Nothing has happened yet.</p></div>';
  }

  return `
    <div class="chips" style="margin-bottom:var(--sp-4)">
      ${TYPES.map(
        ([v, label]) =>
          `<button class="chip" data-action="filterLog" data-v="${v}" aria-pressed="${filter === v}">${label}</button>`
      ).join('')}
    </div>
    <div class="card">
      <div class="timeline">
        ${
          rows.length
            ? rows
                .map(
                  (e) => `<div class="tl-item ${CLS[e.type] ?? ''}">
                    <div class="tl-when">${dayAndTime(e.at)}</div>
                    <div class="tl-what">
                      ${e.ticker ? `<span class="ticker" style="font-size:var(--step-0)">${esc(e.ticker)}</span> ` : ''}
                      ${LINE[e.type]?.(e.payload ?? {}) ?? e.type.toLowerCase()}
                    </div>
                    ${e.payload?.reason ? `<div class="tl-why">${esc(e.payload.reason)}</div>` : ''}
                  </div>`
                )
                .join('')
            : '<p class="muted" style="margin:0">Nothing of that kind yet.</p>'
        }
      </div>
    </div>`;
}

ACTIONS.filterLog = (el) => {
  state.draft.logFilter = state.draft.logFilter === el.dataset.v ? '' : el.dataset.v;
  render();
};
