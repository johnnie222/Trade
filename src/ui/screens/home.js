/**
 * Today V9: operational triage.
 * Open risk first, then positions split into At risk and Protected.
 */

import { ACTIONS } from '../registry.js';
import { openTrades, priceFor } from '../app.js';
import { portfolioRisk, currentR, totalPnl, isProtected, lockedIn } from '../../core/engine.js';
import { priceAge } from '../../data/marketData.js';
import { marketStatusHtml } from '../marketClock.js';
import { dollars, price as fmtPrice, pct, esc } from '../format.js';

const etTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function signedPct(x, dp = 1) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(dp)}%`;
}

function dailyMove(t, p) {
  if (!p || !Number.isFinite(p.price) || !Number.isFinite(p.previousClose) || !(p.previousClose > 0)) return null;
  const perShare = p.price - p.previousClose;
  return {
    dollars: perShare * t.qty,
    percent: Number.isFinite(p.dailyPercent) ? p.dailyPercent : perShare / p.previousClose,
    base: p.previousClose * t.qty,
  };
}

function rTone(r) {
  if (r == null || !Number.isFinite(r) || Math.abs(r) < 0.1) return 'neutral';
  return r > 0 ? 'pos' : 'neg';
}

function rText(r) {
  if (r == null || !Number.isFinite(r)) return '—';
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function stopDistance(t) {
  const p = priceFor(t.ticker);
  if (!p || !(t.riskPerShare > 0)) return Infinity;
  return (p.price - t.activeStop) / t.riskPerShare;
}

function stopBreached(t) {
  const p = priceFor(t.ticker);
  return Boolean(p && p.price < t.activeStop);
}

function neutralRiskRail(t, p) {
  const rps = t.riskPerShare;
  if (!p || !(rps > 0)) return '';
  const stop = t.activeStop;
  const entry = t.entryPrice;
  const end = entry + 2 * rps;
  const span = end - stop;
  if (!(span > 0)) return '';

  const nowPct = Math.max(0, Math.min(100, ((p.price - stop) / span) * 100));
  const r = currentR(t, p.price);
  return `
    <div class="v9-rail" aria-label="R range from stop to 2R">
      <div class="v9-rail-track"></div>
      <span class="v9-rail-tick" style="left:0%"></span>
      <span class="v9-rail-tick" style="left:33.333%"></span>
      <span class="v9-rail-tick" style="left:66.667%"></span>
      <span class="v9-rail-tick" style="left:100%"></span>
      <span class="v9-rail-now ${rTone(r)}" style="left:${nowPct}%"></span>
      <span class="v9-rail-label edge-left" style="left:0%">stop</span>
      <span class="v9-rail-label" style="left:33.333%">entry</span>
      <span class="v9-rail-label" style="left:66.667%">1R</span>
      <span class="v9-rail-label edge-right" style="left:100%">2R</span>
    </div>`;
}

function atRiskRow(t) {
  const p = priceFor(t.ticker);
  const r = p ? currentR(t, p.price) : null;
  const cash = p ? totalPnl(t, p.price) : null;
  const below = p ? p.price < t.activeStop : false;
  return `
    <button class="risk-row" data-go="trade/${t.id}">
      <div class="risk-row-top">
        <span>
          <strong class="ticker">${esc(t.ticker)}</strong>
          <span class="risk-sub ${below ? 'warn' : ''}">
            ${below ? 'Below stop' : 'stop'} ${fmtPrice(t.activeStop)}
            ${cash == null ? '' : ` · ${dollars(cash)}`}
          </span>
        </span>
        <span class="r-chip ${rTone(r)}">${rText(r)}</span>
        <span class="trade-chevron">›</span>
      </div>
      ${neutralRiskRail(t, p)}
    </button>`;
}

function protectedRow(t) {
  const locked = Math.max(0, lockedIn(t));
  return `
    <button class="risk-row protected-row" data-go="trade/${t.id}">
      <div class="risk-row-top">
        <span>
          <strong class="ticker">${esc(t.ticker)}</strong>
          <span class="risk-sub pos">+${dollars(locked, { sign: false })} locked · stop ${fmtPrice(t.activeStop)}</span>
        </span>
        <span class="protected-value">${dollars(locked)}</span>
        <span class="trade-chevron">›</span>
      </div>
    </button>`;
}

function syncBar(sync) {
  if (!sync?.running) return '';
  const done = sync.total ? (sync.done / sync.total) * 100 : 0;
  return `
    <div class="sync" role="status">
      <div class="sync-bar"><div class="sync-fill" style="width:${done}%"></div></div>
      <span class="muted">Fetching ${esc(sync.ticker ?? '')} · ${sync.done}/${sync.total}</span>
    </div>`;
}

function priceStamp(open) {
  const quotes = open.map((t) => priceFor(t.ticker)).filter((p) => p?.at);
  if (!quotes.length) return 'Prices not updated yet';
  const latest = quotes.sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  const source = esc(String(latest.source ?? 'Market data').split(' · ')[0]);
  const age = priceAge(latest);
  return `Prices as of ${etTime.format(new Date(latest.at))} ET · ${source}${age?.level === 'stale' ? ' · stale' : ''}`;
}

function breachAlert(atRisk) {
  const breached = atRisk
    .map((t) => {
      const p = priceFor(t.ticker);
      return p && p.price < t.activeStop ? { t, p, r: currentR(t, p.price), pnl: totalPnl(t, p.price) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.r ?? 0) - (b.r ?? 0));

  if (!breached.length) return '';
  const x = breached[0];
  const planned = x.t.R;
  return `
    <section class="card stop-alert">
      <div class="stop-alert-icon" aria-hidden="true">!</div>
      <div>
        <strong>${esc(x.t.ticker)} is trading below its stop</strong>
        <p>Open loss ${dollars(Math.abs(x.pnl), { sign: false })} is past its planned ~${dollars(planned, { sign: false })} risk (${rText(x.r)}). Record the exit or review the stop.</p>
        <button class="text-action" data-go="trade/${x.t.id}">Review ${esc(x.t.ticker)}</button>
      </div>
    </section>`;
}

export function renderHome(s) {
  const open = openTrades();
  const risk = portfolioRisk(open);

  if (!s.trades.length) {
    return `
      ${marketStatusHtml(s.settings.marketHours)}
      <div class="empty-state">
        <p class="empty-title">Nothing recorded yet</p>
        <p class="muted">Add a trade and the risk, the R targets and the review all follow from it.</p>
        <button class="btn primary" data-go="new">Add your first trade</button>
      </div>`;
  }

  if (!open.length) {
    return `
      ${marketStatusHtml(s.settings.marketHours)}
      <section class="card hero v9-risk-hero">
        <span class="label">Open risk</span>
        <div class="open-risk-number">$0</div>
        <p class="muted">No open positions. The account is flat.</p>
      </section>`;
  }

  const atRisk = open
    .filter((t) => !isProtected(t) || stopBreached(t))
    .sort((a, b) => stopDistance(a) - stopDistance(b));
  const protectedTrades = open.filter((t) => isProtected(t) && !stopBreached(t));
  const unrealized = open.reduce((a, t) => {
    const p = priceFor(t.ticker);
    return a + (p ? totalPnl(t, p.price) : 0);
  }, 0);
  const locked = protectedTrades.reduce((a, t) => a + Math.max(0, lockedIn(t)), 0);

  const daily = open.map((t) => dailyMove(t, priceFor(t.ticker)));
  const hasCompleteDaily = daily.every(Boolean);
  const sessionDollars = hasCompleteDaily ? daily.reduce((a, x) => a + x.dollars, 0) : null;
  const sessionBase = hasCompleteDaily ? daily.reduce((a, x) => a + x.base, 0) : null;
  const sessionPct = sessionBase ? sessionDollars / sessionBase : null;

  const segments = [
    ...atRisk.map(() => '<span class="risk-segment at-risk"></span>'),
    ...protectedTrades.map(() => '<span class="risk-segment protected"></span>'),
  ].join('');

  return `
    ${marketStatusHtml(s.settings.marketHours)}
    ${breachAlert(atRisk)}

    <section class="card hero v9-risk-hero">
      <div class="v9-risk-head">
        <div>
          <span class="label">Open risk</span>
          <div class="open-risk-line">
            <strong class="open-risk-number">${dollars(risk.total, { sign: false })}</strong>
            <span class="muted">${pct(risk.total / s.settings.equity, { dp: 2 })} of account</span>
          </div>
        </div>
        <button class="chip" data-action="syncPrices" ${s.priceSync?.running ? 'disabled' : ''}>
          ${s.priceSync?.running ? 'Updating…' : 'Update prices'}
        </button>
      </div>

      <div class="risk-segments" aria-label="${atRisk.length} at risk, ${protectedTrades.length} protected">${segments}</div>
      <div class="risk-counts">
        <span class="warn">${atRisk.length} at risk</span>
        <span class="pos">${protectedTrades.length} protected</span>
      </div>

      <div class="v9-portfolio-kpis">
        <div><span class="label">Open P&amp;L</span><strong class="${unrealized > 0 ? 'pos' : unrealized < 0 ? 'neg' : ''}">${dollars(unrealized)}</strong></div>
        <div><span class="label">Locked in</span><strong class="pos">${dollars(locked)}</strong></div>
        <div><span class="label">Last session</span><strong class="${sessionDollars > 0 ? 'pos' : sessionDollars < 0 ? 'neg' : ''}">
          ${sessionDollars == null ? '—' : `${dollars(sessionDollars)} ${signedPct(sessionPct)}`}
        </strong></div>
      </div>
    </section>

    ${syncBar(s.priceSync)}

    <div class="section-title v9-group-title">
      <span>At risk</span>
      <span class="muted">closest to stop first</span>
    </div>
    ${atRisk.length ? `<div class="card risk-list">${atRisk.map(atRiskRow).join('')}</div>` : '<div class="card"><p class="muted" style="margin:0">No positions currently at risk.</p></div>'}

    <div class="section-title v9-group-title">
      <span>Protected</span>
      <span class="muted">stop above entry</span>
    </div>
    ${protectedTrades.length ? `<div class="card risk-list">${protectedTrades.map(protectedRow).join('')}</div>` : '<div class="card"><p class="muted" style="margin:0">No protected positions yet.</p></div>'}

    <p class="price-stamp">${priceStamp(open)}</p>`;
}

ACTIONS.syncPrices = async () => {
  const { syncPrices } = await import('../app.js');
  await syncPrices({ manualFallback: true, showProgress: true });
};
