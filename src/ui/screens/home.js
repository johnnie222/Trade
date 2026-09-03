/**
 * Home.
 *
 * Answers one question: what needs attention right now. Account risk first
 * because it is the only number here that is not about a single trade, then the
 * positions, then what happened lately.
 *
 * Every R figure is shown with its dollar value beside it. R is what makes
 * trades comparable; dollars are what the account actually feels. Showing one
 * without the other makes the trader do arithmetic the app already knows.
 */

import { ACTIONS } from '../registry.js';
import { state, openTrades, priceFor, rule } from '../app.js';
import { portfolioRisk, currentR, totalPnl, tradeStatusLabel, isProtected, openRisk, lockedIn } from '../../core/engine.js';
import { evaluateStopRule } from '../../core/stopRules.js';
import { priceAge } from '../../data/marketData.js';
import { rail, rval, dollars, price as fmtPrice, pct, tone, shortDate, daysBetween, esc } from '../format.js';

function ruleFlag(t) {
  const p = priceFor(t.ticker);
  if (!p || !t.rule || t.rule === 'discretionary') return null;
  // Without daily bars the last known price stands in for the highest close.
  // Understating the high can only make a rule quieter, never noisier, which
  // is the right direction to be wrong in.
  const r = evaluateStopRule(rule(t.rule), {
    entryPrice: t.entryPrice,
    riskPerShare: t.riskPerShare,
    activeStop: t.activeStop,
    highestClose: p.price,
    currentPrice: p.price,
  });
  return r.shouldRaise ? r : null;
}

function freshness(p) {
  const age = priceAge(p);
  if (!age) return '';
  return `<span class="stamp ${age.level === 'stale' ? 'warn' : ''}">${fmtPrice(
    p.price
  )} <span class="stamp-age">${age.label}</span></span>`;
}

function tradeCard(t) {
  const p = priceFor(t.ticker);
  const r = p ? currentR(t, p.price) : null;
  const pnl = p ? totalPnl(t, p.price) : null;
  const status = p ? tradeStatusLabel(t, p.price) : 'Open';
  const flag = ruleFlag(t);
  const statusTone = status === 'Near Stop' ? 'warn' : isProtected(t) ? 'pos' : '';
  const chg = p ? (p.price - t.entryPrice) / t.entryPrice : null;

  return `
    <article class="card trade-card" data-go="trade/${t.id}" role="link" tabindex="0">
      <div class="card-head">
        <div>
          <span class="ticker">${esc(t.ticker)}</span>
          <span class="muted" style="margin-left:var(--sp-2)">${esc(t.setup ?? 'Untagged')}</span>
        </div>
        <span class="pill ${statusTone}">${status}</span>
      </div>

      <div class="headline">
        <span class="r ${tone(r)}">${rval(r)}</span>
        <span class="headline-sub ${tone(pnl)}">${dollars(pnl)}</span>
      </div>

      ${rail({
        entry: t.entryPrice,
        stop: t.initialStop,
        activeStop: t.activeStop,
        current: p?.price,
        riskPerShare: t.riskPerShare,
      })}

      <div class="kv">
        <div><span class="label">Now</span><span class="num">${fmtPrice(p?.price)}</span></div>
        <div><span class="label">Change</span><span class="num ${tone(chg)}">${
          chg == null ? '&mdash;' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(2)}%`
        }</span></div>
        <div><span class="label">Stop</span><span class="num ${isProtected(t) ? 'pos' : ''}">${fmtPrice(
          t.activeStop
        )}</span></div>
        <div><span class="label">1R</span><span class="num">${dollars(t.R, { sign: false })}</span></div>
        <div><span class="label">${isProtected(t) ? 'Locked in' : 'At risk'}</span><span class="num ${
          isProtected(t) ? 'pos' : ''
        }">${isProtected(t) ? dollars(lockedIn(t)) : dollars(openRisk(t), { sign: false })}</span></div>
      </div>

      ${
        flag
          ? `<div class="banner warn">
               <span>Your rule says <b class="num">${fmtPrice(flag.target)}</b></span>
               <span class="muted">${esc(flag.triggeredBy)}</span>
             </div>`
          : ''
      }

      <div class="card-foot">
        <span class="muted">Day ${daysBetween(t.openedAt)} &middot; ${t.qty} shares</span>
        ${p ? freshness(p) : '<span class="stamp warn">No price yet</span>'}
      </div>
    </article>`;
}

const VERB = {
  OPEN: (p) => `opened ${p.qty} @ ${fmtPrice(p.price)}`,
  ADD: (p) => `added ${p.qty} @ ${fmtPrice(p.price)}`,
  TRIM: (p) => `trimmed ${p.qty} @ ${fmtPrice(p.price)}`,
  STOP_CHANGE: (p) => `stop &rarr; ${fmtPrice(p.to)}`,
  RULE_OVERRIDE: () => 'skipped the stop rule',
  CLOSE: (p) => `closed @ ${fmtPrice(p.price)}`,
  NOTE: () => 'note',
  SPLIT: (p) => `${p.numerator}:${p.denominator} split`,
  DAILY_NOTE: () => 'daily note',
  TRADE_EDIT: (p) => `corrected ${p.field}`,
};

function syncBar(sync) {
  if (!sync?.running) return '';
  const done = sync.total ? (sync.done / sync.total) * 100 : 0;
  return `
    <div class="sync" role="status">
      <div class="sync-bar"><div class="sync-fill" style="width:${done}%"></div></div>
      <span class="muted">Fetching ${esc(sync.ticker ?? '')} &middot; ${sync.done}/${sync.total}</span>
    </div>`;
}

export function renderHome(s) {
  const open = openTrades();
  const risk = portfolioRisk(open);

  if (!s.trades.length) {
    return `
      <div class="empty-state">
        <p class="empty-title">Nothing recorded yet</p>
        <p class="muted">Add a trade and the risk, the R targets and the review all follow from it.</p>
        <button class="btn primary" data-go="new">Add your first trade</button>
      </div>`;
  }

  const unrealized = open.reduce((a, t) => {
    const p = priceFor(t.ticker);
    return a + (p ? totalPnl(t, p.price) : 0);
  }, 0);

  return `
    <section class="card hero">
      <div class="card-head">
        <span class="label">At risk</span>
        <span class="muted">${open.length} position${open.length === 1 ? '' : 's'}</span>
      </div>
      <div class="headline">
        <span class="num">${dollars(risk.total, { sign: false })}</span>
        <span class="headline-sub muted">${pct(risk.total / s.settings.equity, { dp: 2 })} of account</span>
      </div>
      <div class="hero-split">
        <div><span class="label">Open P&amp;L</span><span class="num r ${tone(unrealized)}">${dollars(
          unrealized
        )}</span></div>
        <div><span class="label">Largest</span><span class="num">${dollars(risk.largest, {
          sign: false,
        })}</span></div>
      </div>
      <p class="fineprint">Assumes every stop fills at its price. A gap does not.</p>
    </section>

    ${syncBar(s.priceSync)}

    <div class="section-title">
      <span class="label">Open</span>
      <button class="chip" data-action="syncPrices" ${s.priceSync?.running ? 'disabled' : ''}>
        ${s.priceSync?.running ? 'Updating…' : 'Update prices'}
      </button>
    </div>
    ${
      open.length
        ? open.map(tradeCard).join('')
        : '<div class="card"><p class="muted" style="margin:0">Nothing open. The account is flat.</p></div>'
    }

    <div class="section-title">
      <span class="label">Recent</span>
      <button class="chip" data-go="log">All</button>
    </div>
    <div class="card">
      <div class="timeline">
        ${s.log
          .slice(0, 6)
          .map(
            (e) => `<div class="tl-item ${e.type === 'RULE_OVERRIDE' ? 'skip' : ''}">
              <div class="tl-when">${shortDate(e.at)}</div>
              <div class="tl-what">
                ${e.ticker ? `<span class="ticker sm">${esc(e.ticker)}</span> ` : ''}
                ${VERB[e.type]?.(e.payload ?? {}) ?? e.type.toLowerCase()}
              </div>
            </div>`
          )
          .join('')}
      </div>
    </div>`;
}

/**
 * Fetch first, ask second.
 *
 * If the feed works this is one tap and nothing is typed. If it does not — and
 * whether it does depends on CORS headers nobody here controls — it falls
 * straight through to typing them, rather than reporting a failure and leaving
 * the trader to find the manual path on their own.
 */
ACTIONS.syncPrices = async () => {
  const { syncPrices } = await import('../app.js');
  await syncPrices({ auto: false });
};
