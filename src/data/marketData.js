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

export const PROVIDERS = { stooq };

/**
 * @param {string} ticker
 * @param {object} [opts] { provider, fetchImpl, timeoutMs }
 */
export async function fetchQuote(ticker, { provider = stooq, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(provider.url(ticker), { signal: controller.signal });
    if (!res.ok) throw new ProviderError(`${provider.label} returned ${res.status}`);
    return provider.parse(await res.text(), ticker);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err.name === 'AbortError') throw new ProviderError('Timed out');
    // A CORS rejection surfaces as an opaque TypeError with no useful detail.
    throw new ProviderError('Could not reach the price source from the browser');
  } finally {
    clearTimeout(timer);
  }
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
