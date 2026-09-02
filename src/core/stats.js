/**
 * Statistics.
 *
 * One aggregation function feeds everything: the dashboard, the weekly review,
 * the monthly review and every breakdown. They differ only in which trades go
 * in and how the result is laid out.
 *
 * Deterministic arithmetic only. No interpretation, no correlation mining, no
 * ranking language. The numbers come out here; reading them is the trader's
 * job, or the job of whatever the export gets pasted into.
 *
 * Three things this module refuses to do, because each one quietly produces a
 * confident wrong answer:
 *   - divide by zero and call the result infinite
 *   - average a set of ratios whose denominators differ wildly
 *   - group trading days by the device's calendar instead of the market's
 */

import { EPS } from './money.js';

export const MIN_SAMPLE = 5;
export const MARKET_TZ = 'America/New_York';

/* ------------------------------------------------------------------ */
/* Market-time period keys                                             */
/* ------------------------------------------------------------------ */

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: MARKET_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The calendar date in market time.
 *
 * This is not cosmetic. A fill at 22:30 in Israel is 15:30 in New York on the
 * SAME trading day. Grouping by the device's date would file it under tomorrow
 * and silently move trades between weeks and months.
 */
export function marketDate(iso) {
  return dateFmt.format(new Date(iso));
}

export function monthKey(iso) {
  return marketDate(iso).slice(0, 7); // YYYY-MM
}

/** ISO date of the Monday of that trading week. */
export function weekKey(iso) {
  const [y, m, d] = marketDate(iso).split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const dow = new Date(utc).getUTCDay(); // 0 Sun … 6 Sat
  const backToMonday = (dow + 6) % 7;
  return new Date(utc - backToMonday * 86400000).toISOString().slice(0, 10);
}

export function weekLabel(key) {
  const start = new Date(`${key}T00:00:00Z`);
  const end = new Date(start.getTime() + 4 * 86400000);
  const fmt = (d) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)}–${end.getDate()}`;
}

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/* ------------------------------------------------------------------ */
/* Helpers that refuse to invent numbers                               */
/* ------------------------------------------------------------------ */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const defined = (xs) => xs.filter((x) => x != null && Number.isFinite(x));

/* ------------------------------------------------------------------ */
/* Core aggregation                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {object[]} summaries  from metrics.tradeSummary, closed trades only
 * @param {object} [opts]       { equity } enables risk-as-%-of-account
 */
export function aggregate(summaries, opts = {}) {
  const closed = summaries.filter((t) => t.status === 'CLOSED');
  const n = closed.length;

  const winners = closed.filter((t) => t.realizedR > EPS);
  const losers = closed.filter((t) => t.realizedR < -EPS);
  const scratches = closed.filter((t) => Math.abs(t.realizedR) <= EPS);

  const grossProfitR = sum(winners.map((t) => t.realizedR));
  const grossLossR = Math.abs(sum(losers.map((t) => t.realizedR)));
  const netR = sum(closed.map((t) => t.realizedR));
  const netPnl = sum(closed.map((t) => t.realizedR * t.R));

  // Trades that offered a given multiple at some point, which is a different
  // question from what they returned. Only answerable where bars exist.
  const withBars = closed.filter((t) => t.mfeR != null);
  const reached = (r) => withBars.filter((t) => t.mfeR >= r).length;
  const gaveBackFrom = (r) => withBars.filter((t) => t.mfeR >= r && t.realizedR < -EPS).length;

  const captureRows = closed.filter((t) => t.mfeCaptured != null);

  return {
    trades: n,
    winners: winners.length,
    losers: losers.length,
    scratches: scratches.length,

    /**
     * Scratches are excluded from the denominator. A trade closed flat is
     * neither a win nor a loss, and counting it as a loss understates the
     * hit rate of the actual decisions.
     */
    winRate: winners.length + losers.length > 0
      ? winners.length / (winners.length + losers.length)
      : null,

    netR,
    netPnl,
    grossProfitR,
    grossLossR,
    grossProfit: sum(winners.map((t) => t.realizedR * t.R)),
    grossLoss: Math.abs(sum(losers.map((t) => t.realizedR * t.R))),

    avgR: n ? netR / n : null,
    expectancy: n ? netR / n : null, // same number, named as traders name it
    avgWinnerR: mean(winners.map((t) => t.realizedR)),
    avgLoserR: mean(losers.map((t) => t.realizedR)),
    avgWinner: mean(winners.map((t) => t.realizedR * t.R)),
    avgLoser: mean(losers.map((t) => t.realizedR * t.R)),

    /**
     * Null rather than Infinity when there were no losers. A period with no
     * losing trades has no profit factor — reporting ∞, or silently coercing
     * it to a large number, is worse than saying so.
     */
    profitFactor: grossLossR > EPS ? grossProfitR / grossLossR : null,

    largestWinnerR: winners.length ? Math.max(...winners.map((t) => t.realizedR)) : null,
    largestLoserR: losers.length ? Math.min(...losers.map((t) => t.realizedR)) : null,

    avgMfeR: mean(defined(closed.map((t) => t.mfeR))),
    avgMaeR: mean(defined(closed.map((t) => t.maeR))),

    /**
     * Two different capture numbers, both honest, neither a substitute:
     *
     * `mfeCaptured` is total realized over total available. It is the number to
     * quote, because it weights each trade by the size of the move it offered.
     *
     * `avgTradeCapture` is the mean of the per-trade ratios. A trade that
     * offered 0.3R and returned 0.3R scores 100% here and pulls the mean up as
     * hard as a 3R trade does, so it answers "how do my trades typically do"
     * rather than "how much of the available move did I take".
     */
    mfeCaptured: (() => {
      const avail = sum(captureRows.map((t) => t.mfeR));
      return avail > EPS ? sum(captureRows.map((t) => t.realizedR)) / avail : null;
    })(),
    avgTradeCapture: mean(captureRows.map((t) => t.mfeCaptured)),

    reached1R: reached(1),
    reached2R: reached(2),
    reached3R: reached(3),
    oneRToLoss: gaveBackFrom(1),
    twoRToLoss: gaveBackFrom(2),
    roundTrips: closed.filter((t) => t.roundTrip).length,

    stopChanges: sum(closed.map((t) => t.stopChanges ?? 0)),
    stopWidenings: sum(closed.map((t) => t.stopWidenings ?? 0)),
    ruleOverrides: sum(closed.map((t) => t.ruleOverrides ?? 0)),

    avgHoldingDays: mean(defined(closed.map((t) => t.holdingDays))),
    avgRisk: mean(closed.map((t) => t.R)),
    avgRiskPct: opts.equity ? mean(closed.map((t) => t.R / opts.equity)) : null,

    /** How many trades the market-data metrics above are actually based on. */
    withMarketData: withBars.length,
    reliable: n >= MIN_SAMPLE,
  };
}

/* ------------------------------------------------------------------ */
/* Breakdowns                                                          */
/* ------------------------------------------------------------------ */

function groupBy(summaries, keyFn, opts) {
  const groups = new Map();
  for (const t of summaries) {
    const key = keyFn(t) ?? '—';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.entries()].map(([key, rows]) => ({
    key,
    ...aggregate(rows, opts),
  }));
}

/**
 * Breakdowns are returned in a stable order and are NOT sorted by performance.
 * Sorting by result invites "best setup" and "worst setup" readings of samples
 * far too small to support them; every row carries `reliable` so the UI can
 * withhold emphasis rather than the data being pre-ranked for it.
 */
export function bySetup(summaries, opts) {
  return groupBy(summaries, (t) => t.setup, opts).sort((a, b) => b.trades - a.trades);
}

export function byEmotion(summaries, opts) {
  return groupBy(summaries, (t) => t.entryEmotion, opts).sort((a, b) => b.trades - a.trades);
}

export function byExitReason(summaries, opts) {
  return groupBy(summaries, (t) => t.exitReason, opts).sort((a, b) => b.trades - a.trades);
}

export function byTicker(summaries, opts) {
  return groupBy(summaries, (t) => t.ticker, opts).sort((a, b) => b.trades - a.trades);
}

/** Chronological. Closed trades are attributed to the month they closed in. */
export function byMonth(summaries, opts) {
  return groupBy(
    summaries.filter((t) => t.closedAt),
    (t) => monthKey(t.closedAt),
    opts
  )
    .map((g) => ({ ...g, label: monthLabel(g.key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function byWeek(summaries, opts) {
  return groupBy(
    summaries.filter((t) => t.closedAt),
    (t) => weekKey(t.closedAt),
    opts
  )
    .map((g) => ({ ...g, label: weekLabel(g.key) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ */
/* Period selection and comparison                                     */
/* ------------------------------------------------------------------ */

export function inPeriod(summaries, { from, to }) {
  return summaries.filter((t) => {
    if (!t.closedAt) return false;
    const d = marketDate(t.closedAt);
    return (!from || d >= from) && (!to || d <= to);
  });
}

const HIGHER_IS_BETTER = new Set([
  'netR', 'netPnl', 'winRate', 'expectancy', 'avgR', 'profitFactor',
  'avgWinnerR', 'avgLoserR', 'mfeCaptured', 'avgTradeCapture',
  'reached1R', 'reached2R', 'reached3R', 'largestWinnerR', 'avgMaeR',
]);
const LOWER_IS_BETTER = new Set([
  'roundTrips', 'oneRToLoss', 'twoRToLoss', 'stopWidenings', 'ruleOverrides',
]);

/**
 * Period-over-period deltas.
 *
 * `direction` is 'better' | 'worse' | 'flat' | null. It is null wherever the
 * metric has no natural direction (trade count, average risk) or where either
 * side is missing — an arrow next to a number that does not exist is a lie,
 * and so is one drawn from three trades.
 */
export function compare(current, previous, { minSample = MIN_SAMPLE } = {}) {
  const out = {};
  for (const key of Object.keys(current)) {
    const now = current[key];
    const then = previous?.[key];
    if (typeof now !== 'number' || typeof then !== 'number') {
      out[key] = { current: now, previous: then ?? null, delta: null, direction: null };
      continue;
    }

    const delta = now - then;
    const enough = current.trades >= minSample && (previous?.trades ?? 0) >= minSample;
    let direction = null;
    if (enough && Math.abs(delta) > EPS) {
      if (HIGHER_IS_BETTER.has(key)) direction = delta > 0 ? 'better' : 'worse';
      else if (LOWER_IS_BETTER.has(key)) direction = delta < 0 ? 'better' : 'worse';
    } else if (enough) {
      direction = 'flat';
    }

    out[key] = {
      current: now,
      previous: then,
      delta,
      pctChange: Math.abs(then) > EPS ? delta / Math.abs(then) : null,
      direction,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The dashboard                                                       */
/* ------------------------------------------------------------------ */

/**
 * Everything the dashboard shows, in one call.
 *
 * @param {object[]} summaries  every trade, open and closed
 * @param {object} opts         { equity, openTrades, months }
 */
export function dashboard(summaries, opts = {}) {
  const { equity = null, openTrades = [], months = 12 } = opts;
  const closed = summaries.filter((t) => t.status === 'CLOSED');

  const allMonths = byMonth(closed, { equity });
  const recentMonths = allMonths.slice(-months);

  const thisMonth = recentMonths.at(-1) ?? null;
  const lastMonth = recentMonths.length > 1 ? recentMonths.at(-2) : null;

  return {
    allTime: aggregate(closed, { equity }),
    thisMonth,
    lastMonth,
    monthOverMonth: thisMonth ? compare(thisMonth, lastMonth) : null,
    months: recentMonths,
    weeks: byWeek(closed, { equity }).slice(-12),
    setups: bySetup(closed, { equity }),
    emotions: byEmotion(closed, { equity }),
    exitReasons: byExitReason(closed, { equity }),
    open: {
      count: openTrades.length,
      tickers: openTrades.map((t) => t.ticker),
    },
  };
}
