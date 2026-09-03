/**
 * Market data.
 *
 * Deliberately the thinnest layer in the product, and entirely optional. The
 * journal is fully usable with prices typed by hand; this only saves typing.
 *
 * THE CORS PROBLEM
 *
 * A browser can only read a response the server explicitly allows it to read.
 * Most free quote endpoints do not send `Access-Control-Allow-Origin`, so they
 * work in curl and fail in a page — which is why this file is written to fail
 * gracefully rather than to assume success. Every failure falls back to the
 * last known price, and manual entry always works.
 *
 * Swapping providers is a one-file change. That is the whole point of the shape.
 */

export class ProviderError extends Error {}

/**
 * Stooq serves free end-of-day CSV with no key and no rate limit worth
 * worrying about. Whether it is readable from a browser depends on headers we
 * cannot verify from here — Settings has a Test button that answers it in one
 * tap on the real device.
 */
export const stooq = {
  id: 'stooq',
  label: 'Stooq (free, end of day)',
  url: (ticker) => `https://stooq.com/q/l/?s=${encodeURIComponent(ticker.toLowerCase())}.us&f=sd2t2ohlcv&h&e=csv`,

  parse(text, ticker) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new ProviderError(`No data for ${ticker}`);
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const values = lines[1].split(',').map((v) => v.trim());
    const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));

    const close = Number.parseFloat(row.close);
    if (!Number.isFinite(close) || close <= 0) {
      // Stooq answers an unknown symbol with N/D rather than an error status.
      throw new ProviderError(`${ticker} not found`);
    }
    return {
      price: close,
      date: row.date ?? null,
      open: Number.parseFloat(row.open) || null,
      high: Number.parseFloat(row.high) || null,
      low: Number.parseFloat(row.low) || null,
      volume: Number.parseFloat(row.volume) || null,
    };
  },
};

export const yahoo = {
  id: 'yahoo',
  label: 'Yahoo Finance',
  url: (ticker) =>
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker.toUpperCase()
    )}?interval=1d&range=5d`,

  parse(text, ticker) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderError(`No data for ${ticker}`);
    }
    const result = payload?.chart?.result?.[0];
    const meta = result?.meta;
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const price = Number(meta?.regularMarketPrice ?? [...closes].reverse().find(Number.isFinite));
    if (!Number.isFinite(price) || price <= 0) throw new ProviderError(`${ticker} not found`);
    const stamp = meta?.regularMarketTime;
    return {
      price,
      date: stamp ? new Date(stamp * 1000).toISOString().slice(0, 10) : null,
      open: Number(meta?.regularMarketOpen) || null,
      high: Number(meta?.regularMarketDayHigh) || null,
      low: Number(meta?.regularMarketDayLow) || null,
      volume: Number(meta?.regularMarketVolume) || null,
    };
  },
};

export const PROVIDERS = { stooq, yahoo };
export const DEFAULT_PROVIDERS = [stooq, yahoo];

/**
 * @param {string} ticker
 * @param {object} [opts] { provider, fetchImpl, timeoutMs }
 */
export async function fetchQuote(
  ticker,
  { provider = null, providers = DEFAULT_PROVIDERS, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}
) {
  const attempts = provider ? [provider] : providers;
  let lastError = null;
  for (const source of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(source.url(ticker), { signal: controller.signal });
      if (!res.ok) throw new ProviderError(`${source.label} returned ${res.status}`);
      return { ...source.parse(await res.text(), ticker), provider: source.id };
    } catch (err) {
      if (err?.name === 'AbortError') lastError = new ProviderError('Timed out');
      else if (err instanceof ProviderError) lastError = err;
      else lastError = new ProviderError('Could not reach the price source from the browser');
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ProviderError('Could not reach the price source from the browser');
}

/* ------------------------------------------------------------------ */
/* Freshness                                                           */
/* ------------------------------------------------------------------ */

export const AUTO_UPDATE_MIN_AGE_MIN = 30;

/**
 * One refresh per app open, and not more often than every half hour.
 *
 * Reopening the app three times in a minute should not mean three round trips
 * for the same end-of-day number that will not change until tomorrow.
 */
export function shouldAutoUpdate({ enabled, lastRunAt, now = new Date(), minAgeMin = AUTO_UPDATE_MIN_AGE_MIN }) {
  if (!enabled) return { update: false, reason: 'auto-update is off' };
  if (!lastRunAt) return { update: true, reason: 'never run' };
  const ageMin = (new Date(now) - new Date(lastRunAt)) / 60000;
  return ageMin >= minAgeMin
    ? { update: true, reason: `${Math.floor(ageMin)} minutes since the last check` }
    : { update: false, reason: 'checked recently' };
}

/** Age of a stored price, for the freshness indicator. */
export function priceAge(entry, now = new Date()) {
  if (!entry?.at) return null;
  const hours = (new Date(now) - new Date(entry.at)) / 3600000;
  if (hours < 20) return { level: 'fresh', label: 'today', hours };
  if (hours < 96) return { level: 'ok', label: `${Math.round(hours / 24)}d ago`, hours };
  return { level: 'stale', label: `${Math.round(hours / 24)}d ago`, hours };
}

/* ------------------------------------------------------------------ */
/* The queue                                                           */
/* ------------------------------------------------------------------ */

/**
 * Fetch tickers one at a time, reporting progress as it goes.
 *
 * Sequential rather than parallel on purpose. A handful of open positions is
 * a handful of requests, and firing them together is the surest way to get
 * throttled by a free endpoint for no gain a person could perceive.
 *
 * One failure never stops the run. A ticker that cannot be fetched keeps its
 * last known price and is reported; the rest still update.
 */
export async function updatePrices(tickers, { onProgress = () => {}, gapMs = 250, ...opts } = {}) {
  const results = { updated: [], failed: [], total: tickers.length };

  for (const [i, ticker] of tickers.entries()) {
    onProgress({ ticker, done: i, total: tickers.length, phase: 'fetching' });
    try {
      const quote = await fetchQuote(ticker, opts);
      results.updated.push({ ticker, ...quote });
    } catch (err) {
      results.failed.push({ ticker, error: err.message });
    }
    if (gapMs && i < tickers.length - 1) await new Promise((r) => setTimeout(r, gapMs));
  }

  onProgress({ done: tickers.length, total: tickers.length, phase: 'done' });
  return results;
}

/** One-line summary for the toast. */
export function summarize(results) {
  const { updated, failed } = results;
  if (!updated.length && !failed.length) return 'Nothing to update';
  if (!failed.length) return `Updated ${updated.length} price${updated.length === 1 ? '' : 's'}`;
  if (!updated.length) return `Could not reach the price source — ${failed[0].error}`;
  return `Updated ${updated.length}, ${failed.length} failed`;
}
