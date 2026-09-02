/**
 * The review export.
 *
 * This is the feature that replaces an insight engine. The app computes the
 * facts; the trader pastes them somewhere that can interpret them.
 *
 * Design constraint: small enough to paste, complete enough that the analysis
 * is grounded in what actually happened. Aggregates alone would produce
 * generic advice, so the event log for the period goes in too — every stop
 * change, every skipped rule with its stated reason. That is the difference
 * between "improve your profit protection" and "you skipped your own rule
 * twice, both times to hold for a gap fill, and both gave back 2R".
 */

import { aggregate, bySetup, byEmotion, byExitReason, weekLabel, monthLabel, marketDate } from '../core/stats.js';
import { tradeSummary } from '../core/metrics.js';

const r = (x, dp = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(dp)}R`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const num = (x, dp = 2) => (x == null ? '—' : x.toFixed(dp));
const usd = (x) =>
  x == null ? '—' : `${x < 0 ? '-' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`;

function statsBlock(s, label) {
  return [
    `## ${label}`,
    '',
    `- Trades: ${s.trades} (${s.winners}W / ${s.losers}L${s.scratches ? ` / ${s.scratches} flat` : ''})`,
    `- Win rate: ${pct(s.winRate)}`,
    `- Net: ${r(s.netR)} · ${usd(s.netPnl)}`,
    `- Expectancy: ${r(s.expectancy)} per trade`,
    `- Profit factor: ${num(s.profitFactor)}`,
    `- Average winner: ${r(s.avgWinnerR)} · average loser: ${r(s.avgLoserR)}`,
    `- Largest winner: ${r(s.largestWinnerR)} · largest loser: ${r(s.largestLoserR)}`,
    `- Average MFE: ${r(s.avgMfeR)} · average MAE: ${r(s.avgMaeR)}`,
    `- MFE captured: ${pct(s.mfeCaptured)}${
      s.withMarketData < s.trades ? ` (from ${s.withMarketData} of ${s.trades} trades with price history)` : ''
    }`,
    `- Reached 1R: ${s.reached1R} · 2R: ${s.reached2R} · 3R: ${s.reached3R}`,
    `- Gave back from 1R to a loss: ${s.oneRToLoss} · from 2R: ${s.twoRToLoss}`,
    `- Round trips: ${s.roundTrips}`,
    `- Stop changes: ${s.stopChanges} · stops widened: ${s.stopWidenings} · rule overrides: ${s.ruleOverrides}`,
    `- Average holding period: ${num(s.avgHoldingDays, 1)} days`,
    `- Average risk: ${usd(s.avgRisk)}${s.avgRiskPct != null ? ` (${pct(s.avgRiskPct)} of equity)` : ''}`,
  ].join('\n');
}

function breakdownTable(rows, title, keyLabel) {
  if (!rows.length) return '';
  const lines = [
    `### ${title}`,
    '',
    `| ${keyLabel} | Trades | W/L | Net | Avg | Sample |`,
    '|---|---:|---:|---:|---:|---|',
    ...rows.map(
      (g) =>
        `| ${g.key} | ${g.trades} | ${g.winners}/${g.losers} | ${r(g.netR)} | ${r(g.avgR)} | ${
          g.reliable ? 'ok' : 'too small'
        } |`
    ),
  ];
  return lines.join('\n');
}

function tradeLine(t, s) {
  const bits = [
    `- **${t.ticker}** ${t.setup ?? 'untagged'} · ${marketDate(t.openedAt)}→${
      t.closedAt ? marketDate(t.closedAt) : 'open'
    }`,
    `entry ${t.entryPrice} stop ${t.initialStop}`,
    t.status === 'CLOSED' ? `exit ${t.exitPrice} (${t.exitReason ?? 'no reason given'})` : 'still open',
    `**${r(s.realizedR)}**`,
  ];
  if (s.mfeR != null) bits.push(`MFE ${r(s.mfeR)} MAE ${r(s.maeR)}`);
  if (s.roundTrip) bits.push('**round trip**');
  if (s.ruleOverrides) bits.push(`${s.ruleOverrides} rule override(s)`);
  if (t.entryEmotion) bits.push(t.entryEmotion);
  return bits.join(' · ');
}

const EVENT_VERB = {
  OPEN: (p) => `opened ${p.qty} @ ${p.price}, stop ${p.stop}`,
  ADD: (p) => `added ${p.qty} @ ${p.price}`,
  TRIM: (p) => `trimmed ${p.qty} @ ${p.price}`,
  STOP_CHANGE: (p) => `stop ${p.from ?? '?'} → ${p.to}${p.reason ? ` (${p.reason})` : ''}${p.source === 'rule' ? ' [by rule]' : ''}`,
  RULE_OVERRIDE: (p) => `SKIPPED the stop rule, which said ${p.ruleStop}${p.reason ? ` — "${p.reason}"` : ''}`,
  SPLIT: (p) => `${p.numerator}:${p.denominator} split`,
  NOTE: (p) => `note — "${p.text}"`,
  CLOSE: (p) => `closed @ ${p.price}${p.reason ? ` (${p.reason})` : ''}`,
  TRADE_EDIT: (p) => `corrected ${p.field}: ${p.from} → ${p.to}`,
  DAILY_NOTE: (p) => `daily note — "${p.text}"`,
};

function eventLine(e) {
  const verb = EVENT_VERB[e.type]?.(e.payload ?? {}) ?? e.type.toLowerCase();
  return `- ${e.at.slice(0, 16).replace('T', ' ')} · ${e.ticker ?? '—'} · ${verb}`;
}

/**
 * @param {object} input
 *   period      { label, from, to }
 *   trades      projected trades closed in the period
 *   openTrades  projected trades still open at period end
 *   log         activity log rows for the period
 *   previous    aggregate() of the prior period, or null
 *   equity
 */
export function reviewMarkdown({
  period,
  trades,
  openTrades = [],
  log = [],
  previous = null,
  equity = null,
  barsByTicker = {},
}) {
  const summaries = trades.map((t) => tradeSummary(t, barsByTicker[t.ticker] ?? null));
  const s = aggregate(summaries, { equity });

  const parts = [
    `# Trading review — ${period.label}`,
    '',
    `Period: ${period.from} to ${period.to}. All figures are R-denominated, where 1R is the dollar risk locked in when each trade was opened. MFE and MAE are daily-bar resolution.`,
    '',
    statsBlock(s, 'Summary'),
  ];

  if (previous) {
    const d = (k, fmt = r) => `${fmt(s[k])} vs ${fmt(previous[k])}`;
    parts.push(
      '',
      '## Versus the previous period',
      '',
      `- Trades: ${s.trades} vs ${previous.trades}`,
      `- Net: ${d('netR')}`,
      `- Win rate: ${d('winRate', pct)}`,
      `- Expectancy: ${d('expectancy')}`,
      `- MFE captured: ${d('mfeCaptured', pct)}`,
      `- Round trips: ${s.roundTrips} vs ${previous.roundTrips}`,
      `- Rule overrides: ${s.ruleOverrides} vs ${previous.ruleOverrides}`,
      '',
      `Note: with ${s.trades} and ${previous.trades} trades, treat any difference as an observation rather than a trend.`
    );
  }

  const setups = bySetup(summaries, { equity });
  const emotions = byEmotion(summaries, { equity });
  const exits = byExitReason(summaries, { equity });
  const tables = [
    breakdownTable(setups, 'By setup', 'Setup'),
    breakdownTable(emotions, 'By emotion at entry', 'Emotion'),
    breakdownTable(exits, 'By exit reason', 'Reason'),
  ].filter(Boolean);
  if (tables.length) parts.push('', '## Breakdowns', '', tables.join('\n\n'));

  parts.push('', '## Trades closed', '');
  parts.push(
    trades.length
      ? trades.map((t, i) => tradeLine(t, summaries[i])).join('\n')
      : '_No trades closed in this period._'
  );

  if (openTrades.length) {
    parts.push('', '## Still open at period end', '');
    parts.push(
      openTrades
        .map((t) => `- **${t.ticker}** ${t.setup ?? 'untagged'} · opened ${marketDate(t.openedAt)} · entry ${t.entryPrice} · stop ${t.activeStop}`)
        .join('\n')
    );
  }

  if (log.length) {
    parts.push('', '## Everything that happened', '');
    parts.push([...log].reverse().map(eventLine).join('\n'));
  }

  parts.push(
    '',
    '---',
    '',
    'These are measured facts from the journal. No interpretation has been applied to them.'
  );

  return parts.join('\n');
}

export function weeklyReviewMarkdown(input) {
  const label = `week of ${weekLabel(input.period.from)}`;
  return reviewMarkdown({ ...input, period: { ...input.period, label } });
}

export function monthlyReviewMarkdown(input) {
  const label = monthLabel(input.period.from.slice(0, 7));
  return reviewMarkdown({ ...input, period: { ...input.period, label } });
}
