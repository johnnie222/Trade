/**
 * Home.
 *
 * Answers one question: what needs attention right now. Portfolio risk at the
 * top because it is the only number that is about the account rather than any
 * one trade, then the open positions, then what happened lately.
 *
 * Closed trades are not here. They are history, and history has its own screen.
 */

import { ACTIONS } from '../registry.js';
import { state, openTrades, priceFor, go, rule } from '../app.js';
import { portfolioRisk, currentR, tradeStatusLabel, isProtected, openRisk } from '../../core/engine.js';
import { evaluateStopRule } from '../../core/stopRules.js';
import { rail, rval, dollars, price as fmtPrice, pct, tone, shortDate, daysBetween, esc } from '../format.js';

function ruleFlag(t) {
  const p = priceFor(t.ticker);
  if (!p || !t.rule) return null;
  // Without bars, the last known price stands in for the highest close. It is
  // the only observation available in a manual journal, and understating the
  // high can only make the rule quieter, never noisier.
  const r = evaluateStopRule(rule(t.rule), {
    entryPrice: t.entryPrice,
    riskPerShare: t.riskPerShare,
    activeStop: t.activeStop,
    highestClose: p.price,
    currentPrice: p.price,
  });
  return r.shouldRaise ? r : null;
}

function tradeCard(t) {
  const p = priceFor(t.ticker);
  const r = p ? currentR(t, p.price) : null;
  const status = p ? tradeStatusLabel(t, p.price) : 'Open';
  const flag = ruleFlag(t);
  const statusTone = status === 'Near Stop' ? 'warn' : isProtected(t) ? 'pos' : '';

  return `
    <article class="card tappable" data-go="trade/${t.id}">
      <div class="card-head">
        <span class="ticker">${esc(t.ticker)}</span>
        <span class="r big ${tone(r)}">${rval(r)}</span>
      </div>
      <div class="card-head" style="margin-bottom:0">
        <span class="muted">${esc(t.setup ?? 'Untagged')} · day ${daysBetween(t.openedAt)}</span>
        <span class="pill ${statusTone}">${status}</span>
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
        <div><span class="label">Entry</span><span class="num">${fmtPrice(t.avgCost)}</span></div>
        <div><span class="label">Stop</span><span class="num">${fmtPrice(t.activeStop)}</span></div>
        <div><span class="label">Risk</span><span class="num">${
          openRisk(t) > 0 ? dollars(openRisk(t), { sign: false }) : '<span class="pos">none</span>'
        }</span></div>
      </div>

      ${
        flag
          ? `<div class="pill warn" style="margin-top:var(--sp-3);display:block;text-align:center">
               Your rule says ${fmtPrice(flag.target)} · ${flag.triggeredBy}
             </div>`
          : ''
      }
      ${
        p
          ? `<p class="muted" style="margin:var(--sp-2) 0 0;font-size:var(--step--1)">
               ${esc(p.source)} · ${shortDate(p.at)}
             </p>`
          : `<p class="muted" style="margin:var(--sp-2) 0 0;font-size:var(--step--1)">No price yet</p>`
      }
    </article>`;
}

const VERB = {
  OPEN: (p, e) => `opened ${p.qty} @ ${fmtPrice(p.price)}`,
  ADD: (p) => `added ${p.qty} @ ${fmtPrice(p.price)}`,
  TRIM: (p) => `trimmed ${p.qty} @ ${fmtPrice(p.price)}`,
  STOP_CHANGE: (p) => `stop → ${fmtPrice(p.to)}`,
  RULE_OVERRIDE: () => 'skipped the stop rule',
  CLOSE: (p) => `closed @ ${fmtPrice(p.price)}`,
  NOTE: () => 'note',
  SPLIT: (p) => `${p.numerator}:${p.denominator} split`,
  DAILY_NOTE: () => 'daily note',
  TRADE_EDIT: (p) => `corrected ${p.field}`,
};

export function renderHome(s) {
  const open = openTrades();
  const risk = portfolioRisk(open);
  const recent = s.log.slice(0, 6);

  if (!s.trades.length) {
    return `
      <div class="empty-state">
        <p>Nothing recorded yet.</p>
        <p class="muted">Add a trade and the risk, the R targets and the review all follow from it.</p>
        <button class="btn primary" data-go="new">Add your first trade</button>
      </div>`;
  }

  return `
    <section class="card">
      <div class="card-head">
        <span class="label">Open risk</span>
        <span class="muted">${open.length} position${open.length === 1 ? '' : 's'}</span>
      </div>
      <div class="big num">${dollars(risk.total, { sign: false })}</div>
      <p class="muted" style="margin:var(--sp-1) 0 0">
        ${pct(risk.total / s.settings.equity, { dp: 2 })} of account · largest ${dollars(risk.largest, {
    sign: false,
  })} · excludes gaps
      </p>
    </section>

    <div class="section-title">
      <span class="label">Open positions</span>
      <button class="chip" data-action="updatePrices">Update prices</button>
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
        ${recent
          .map(
            (e) => `<div class="tl-item ${e.type === 'RULE_OVERRIDE' ? 'skip' : ''}">
              <div class="tl-when">${shortDate(e.at)}</div>
              <div class="tl-what">
                ${e.ticker ? `<span class="ticker" style="font-size:var(--step-0)">${esc(e.ticker)}</span> ` : ''}
                ${VERB[e.type]?.(e.payload ?? {}, e) ?? e.type.toLowerCase()}
              </div>
            </div>`
          )
          .join('')}
      </div>
    </div>`;
}

/**
 * Manual price entry, one prompt per open ticker.
 *
 * Crude on purpose. In Phase 1 there is no market data, and the alternative to
 * a quick prompt is a screen the trader has to visit — which is the exact
 * friction the product exists to remove. Phase 2 replaces this wholesale with
 * an EOD fetch, and nothing else changes because prices already live outside
 * the event log.
 */
ACTIONS.updatePrices = async () => {
  const { setPrice, render, toast } = await import('../app.js');
  const tickers = [...new Set(openTrades().map((t) => t.ticker))];
  let updated = 0;
  for (const ticker of tickers) {
    const current = priceFor(ticker)?.price ?? '';
    const input = window.prompt(`Last price for ${ticker}`, current);
    if (input == null) break;
    const value = Number.parseFloat(input);
    if (Number.isFinite(value) && value > 0) {
      await setPrice(ticker, value, 'manual');
      updated += 1;
    }
  }
  if (updated) toast(`Updated ${updated} price${updated === 1 ? '' : 's'}`);
  else render();
};
