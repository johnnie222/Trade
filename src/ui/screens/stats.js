/**
 * Stats.
 *
 * Deterministic numbers and one button that hands them to something that can
 * interpret them. There is no advice on this screen by design: the app is
 * confident about arithmetic and has no business being confident about what
 * the arithmetic means.
 *
 * Breakdown rows below the sample threshold are shown with their numbers and
 * marked, not hidden. Hiding them would imply the data does not exist; marking
 * them says it exists and does not yet support a conclusion.
 */

import { ACTIONS } from '../registry.js';
import { state, summaries, openTrades, closedTrades, toast } from '../app.js';
import {
  dashboard, aggregate, inPeriod, weekKey, weekLabel, monthLabel, marketDate, MIN_SAMPLE,
} from '../../core/stats.js';
import { reviewMarkdown } from '../../export/markdown.js';
import { tradesCsv, eventsCsv } from '../../export/csv.js';
import { rval, dollars, pct, num, tone, esc, DASH } from '../format.js';

const PERIODS = [
  ['month', 'This month'],
  ['week', 'This week'],
  ['all', 'All time'],
];

function statGrid(s) {
  const cells = [
    ['Net', rval(s.netR), tone(s.netR)],
    ['P&L', dollars(s.netPnl), tone(s.netPnl)],
    ['Trades', String(s.trades), ''],
    ['Win rate', pct(s.winRate), ''],
    ['Expectancy', rval(s.expectancy), tone(s.expectancy)],
    ['Profit factor', num(s.profitFactor), ''],
    ['Avg winner', rval(s.avgWinnerR), 'pos'],
    ['Avg loser', rval(s.avgLoserR), 'neg'],
    ['Best', rval(s.largestWinnerR), ''],
    ['Worst', rval(s.largestLoserR), ''],
    ['Avg hold', s.avgHoldingDays == null ? DASH : `${num(s.avgHoldingDays, 1)}d`, ''],
    ['Avg risk', dollars(s.avgRisk, { sign: false }), ''],
  ];
  return `<div class="kv">${cells
    .map(
      ([label, value, cls]) =>
        `<div><span class="label">${label}</span><span class="num r ${cls}">${value}</span></div>`
    )
    .join('')}</div>`;
}

function winLossBar(s) {
  const total = s.winners + s.losers + s.scratches;
  if (!total) return '';
  const w = (s.winners / total) * 100;
  const l = (s.losers / total) * 100;
  return `
    <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin:var(--sp-3) 0 var(--sp-2);background:var(--surface-2)">
      <div style="width:${w}%;background:var(--pos)"></div>
      <div style="width:${l}%;background:var(--neg)"></div>
    </div>
    <p class="muted" style="margin:0;font-size:var(--step--1)">
      <span class="pos">${s.winners} winners ${rval(s.grossProfitR)}</span> ·
      <span class="neg">${s.losers} losers ${rval(-s.grossLossR)}</span>${
    s.scratches ? ` · ${s.scratches} flat` : ''
  }
    </p>`;
}

function managementBlock(s) {
  if (!s.withMarketData) {
    return `<p class="muted" style="margin:0">
      Trade management stats need price history. ${s.trades} trade${s.trades === 1 ? '' : 's'} recorded, none with bars yet.
    </p>`;
  }
  return `
    <div class="kv">
      <div><span class="label">MFE captured</span><span class="num r">${pct(s.mfeCaptured)}</span></div>
      <div><span class="label">Avg MFE</span><span class="num">${rval(s.avgMfeR)}</span></div>
      <div><span class="label">Avg MAE</span><span class="num">${rval(s.avgMaeR)}</span></div>
      <div><span class="label">Reached 1R</span><span class="num">${s.reached1R}</span></div>
      <div><span class="label">Reached 2R</span><span class="num">${s.reached2R}</span></div>
      <div><span class="label">Round trips</span><span class="num ${s.roundTrips ? 'warn' : ''}">${s.roundTrips}</span></div>
    </div>
    <p class="muted" style="margin:var(--sp-3) 0 0;font-size:var(--step--1)">
      From ${s.withMarketData} of ${s.trades} trades with price history. Daily-bar resolution.
    </p>`;
}

function breakdown(rows, title) {
  if (!rows.length) return '';
  return `
    <div class="section-title"><span class="label">${title}</span></div>
    <div class="card">
      <table>
        <thead><tr><th>${title}</th><th>N</th><th>W/L</th><th>Net</th><th>Avg</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (g) => `<tr class="${g.reliable ? '' : 'faint'}">
                <td>${esc(g.key)}${g.reliable ? '' : ' <span class="muted">·</span>'}</td>
                <td class="num">${g.trades}</td>
                <td class="num">${g.winners}/${g.losers}</td>
                <td class="num r ${tone(g.netR)}">${rval(g.netR)}</td>
                <td class="num ${tone(g.avgR)}">${rval(g.avgR)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
      ${
        rows.some((g) => !g.reliable)
          ? `<p class="muted" style="margin:var(--sp-3) 0 0;font-size:var(--step--1)">
               Dimmed rows have fewer than ${MIN_SAMPLE} trades. The numbers are real; they are not yet a pattern.
             </p>`
          : ''
      }
    </div>`;
}

function monthTable(months) {
  if (!months.length) return '';
  return `
    <div class="section-title"><span class="label">By month</span></div>
    <div class="card">
      <table>
        <thead><tr><th>Month</th><th>N</th><th>W/L</th><th>Net</th><th>Win%</th></tr></thead>
        <tbody>
          ${[...months]
            .reverse()
            .map(
              (m) => `<tr>
                <td>${esc(m.label)}</td>
                <td class="num">${m.trades}</td>
                <td class="num">${m.winners}/${m.losers}</td>
                <td class="num r ${tone(m.netR)}">${rval(m.netR)}</td>
                <td class="num">${pct(m.winRate)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function periodTrades(period) {
  const closed = closedTrades();
  if (period === 'all') return closed;
  const today = marketDate(new Date().toISOString());
  if (period === 'month') {
    const from = `${today.slice(0, 7)}-01`;
    return closed.filter((t) => marketDate(t.closedAt) >= from);
  }
  const from = weekKey(new Date().toISOString());
  return closed.filter((t) => marketDate(t.closedAt) >= from);
}

export function renderStats(s) {
  if (!closedTrades().length) {
    return `<div class="empty-state">
      <p>Stats appear once trades are closed.</p>
      <p class="muted">${openTrades().length} open right now.</p>
    </div>`;
  }

  const period = s.draft.statsPeriod ?? 'all';
  const sums = periodTrades(period).map((t) => summaries().find((x) => x.id === t.id));
  const agg = aggregate(sums, { equity: s.settings.equity });
  const d = dashboard(summaries(), { equity: s.settings.equity, openTrades: openTrades() });

  return `
    <div class="chips" style="margin-bottom:var(--sp-4)">
      ${PERIODS.map(
        ([v, label]) =>
          `<button class="chip" data-action="statsPeriod" data-v="${v}" aria-pressed="${period === v}">${label}</button>`
      ).join('')}
    </div>

    <section class="card">
      <div class="card-head">
        <span class="label">${PERIODS.find(([v]) => v === period)[1]}</span>
        <span class="muted">${agg.trades} closed</span>
      </div>
      ${winLossBar(agg)}
      ${statGrid(agg)}
    </section>

    <div class="section-title"><span class="label">Trade management</span></div>
    <div class="card">${managementBlock(agg)}</div>

    ${monthTable(d.months)}
    ${breakdown(d.setups, 'Setup')}
    ${breakdown(d.emotions, 'Emotion')}
    ${breakdown(d.exitReasons, 'Exit reason')}

    <div class="section-title"><span class="label">Export</span></div>
    <div class="card">
      <p class="muted" style="margin:0 0 var(--sp-3)">
        The review copies the period's numbers, one line per trade and the full event log —
        including every skipped rule and the reason you gave. Paste it anywhere that can read it.
      </p>
      <div class="btn-row">
        <button class="btn primary" data-action="copyReview" data-period="week">Copy week</button>
        <button class="btn primary" data-action="copyReview" data-period="month">Copy month</button>
      </div>
      <div class="btn-row" style="margin-top:var(--sp-2)">
        <button class="btn" data-action="downloadCsv" data-kind="trades">Trades CSV</button>
        <button class="btn" data-action="downloadCsv" data-kind="events">Events CSV</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */

ACTIONS.statsPeriod = (el) => {
  state.draft.statsPeriod = el.dataset.v;
  import('../app.js').then((m) => m.render());
};

function periodBounds(kind) {
  const now = new Date().toISOString();
  if (kind === 'week') {
    const from = weekKey(now);
    const to = new Date(new Date(`${from}T00:00:00Z`).getTime() + 4 * 86400000)
      .toISOString()
      .slice(0, 10);
    return { from, to, label: `week of ${weekLabel(from)}` };
  }
  const month = marketDate(now).slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  return {
    from: `${month}-01`,
    to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
    label: monthLabel(month),
  };
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied · ${(text.length / 1000).toFixed(1)}k characters`);
  } catch {
    // Clipboard access can be refused; a download is never refused.
    downloadFile(`${what.toLowerCase().replace(/\s+/g, '-')}.md`, text, 'text/markdown');
    toast('Clipboard blocked — downloaded instead');
  }
}

function downloadFile(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

ACTIONS.copyReview = async (el) => {
  const kind = el.dataset.period;
  const bounds = periodBounds(kind);
  const sums = summaries();
  const inWindow = inPeriod(sums, bounds).map((x) => x.id);
  const trades = closedTrades().filter((t) => inWindow.includes(t.id));

  const log = await state.repo.activityLog({
    from: `${bounds.from}T00:00:00Z`,
    to: `${bounds.to}T23:59:59Z`,
  });

  // The prior period of the same length, for the comparison block.
  const days = kind === 'week' ? 7 : 30;
  const shift = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);
  const prevBounds = { from: shift(bounds.from, days), to: shift(bounds.to, days) };
  const prev = inPeriod(sums, prevBounds);

  const md = reviewMarkdown({
    period: bounds,
    trades,
    openTrades: openTrades(),
    log,
    previous: prev.length ? aggregate(prev, { equity: state.settings.equity }) : null,
    equity: state.settings.equity,
  });

  await copyText(md, kind === 'week' ? 'Weekly review' : 'Monthly review');
};

ACTIONS.downloadCsv = (el) => {
  const today = marketDate(new Date().toISOString());
  if (el.dataset.kind === 'trades') {
    downloadFile(`trades-${today}.csv`, tradesCsv(state.trades), 'text/csv');
  } else {
    downloadFile(`events-${today}.csv`, eventsCsv(state.log), 'text/csv');
  }
  toast('Downloaded');
};
