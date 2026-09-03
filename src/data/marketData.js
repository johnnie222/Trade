/**
 * Market data snapshots.
 *
 * There is deliberately no stream and no polling loop here. Quotes are fetched
 * only when the UI asks for one: ticker entry, opening a trade, the Update
 * prices button, or immediately before a price-sensitive action.
 *
 * Provider order for the product is Twelve Data -> Yahoo -> manual entry.
 * Twelve Data needs the user's own API key. The key is stored in localStorage,
 * outside the journal database and outside backups, so it is never committed or
 * exported with trading history.
 */

export class ProviderError extends Error {}

export const TWELVE_DATA_KEY = 'trade-journal:twelve-data-key';

export function getTwelveDataKey(storage = globalThis.localStorage) {
  try {
    return storage?.getItem?.(TWELVE_DATA_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function setTwelveDataKey(value, storage = globalThis.localStorage) {
  const key = String(value ?? '').trim();
  try {
    if (!storage?.setItem) return key;
    if (key) storage.setItem(TWELVE_DATA_KEY, key);
    else storage.removeItem(TWELVE_DATA_KEY);
  } catch {
    // Private browsing / storage policy can refuse localStorage. Price fetching
    // still works for this session if the caller supplies apiKey directly.
  }
  return key;
}

const finite = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Twelve Data /quote costs the same credit as /price, but gives the previous
 * close and daily context as well. prepost is intentionally NOT requested: the
 * journal displays regular-session prices even while the clock says pre/after.
 */
export function twelveData(apiKey) {
  const key = String(apiKey ?? '').trim();
  return {
    id: 'twelve',
    label: 'Twelve Data',
    url: (ticker) =>
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker.toUpperCase())}&apikey=${encodeURIComponent(key)}`,
    parse(text, ticker) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ProviderError(`No data for ${ticker}`);
      }
      if (payload?.status === 'error') throw new ProviderError(payload.message || `No data for ${ticker}`);

      const price = finite(payload?.close ?? payload?.price);
      if (!(price > 0)) throw new ProviderError(`${ticker} not found`);
      const previousClose = finite(payload?.previous_close);
      const change = finite(payload?.change) ?? (previousClose != null ? price - previousClose : null);
      const pctFromProvider = finite(payload?.percent_change);
      const dailyPercent =
        pctFromProvider != null ? pctFromProvider / 100 : previousClose ? (price - previousClose) / previousClose : null;

      return {
        price,
        previousClose,
        change,
        dailyPercent,
        date: payload?.datetime?.slice?.(0, 10) ?? null,
        datetime: payload?.datetime ?? null,
        timestamp: finite(payload?.timestamp),
        name: payload?.name ?? null,
        exchange: payload?.exchange ?? null,
        open: finite(payload?.open),
        high: finite(payload?.high),
        low: finite(payload?.low),
        volume: finite(payload?.volume),
        averageVolume: finite(payload?.average_volume),
        isMarketOpen: typeof payload?.is_market_open === 'boolean' ? payload.is_market_open : null,
        fiftyTwoWeek: payload?.fifty_two_week ?? null,
      };
    },
  };
}

/** A company logo is metadata, fetched once and cached by the app. */
export async function fetchLogo(
  ticker,
  { apiKey = getTwelveDataKey(), fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}
) {
  const key = String(apiKey ?? '').trim();
  if (!key) return null;
  const symbol = String(ticker ?? '').trim().toUpperCase();
  if (!symbol) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://api.twelvedata.com/logo?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    const payload = JSON.parse(await res.text());
    if (payload?.status === 'error') return null;
    return typeof payload?.url === 'string' && payload.url ? payload.url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Kept as an explicit provider for tests / emergency fallback experiments. */
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
    if (!Number.isFinite(close) || close <= 0) throw new ProviderError(`${ticker} not found`);
    return {
      price: close,
      previousClose: null,
      change: null,
      dailyPercent: null,
      date: row.date ?? null,
      open: Number.parseFloat(row.open) || null,
      high: Number.parseFloat(row.high) || null,
      low: Number.parseFloat(row.low) || null,
      volume: Number.parseFloat(row.volume) || null,
    };
  },
};

/**
 * Yahoo remains a fallback, but regularMarketPrice is used deliberately. Do not
 * substitute preMarketPrice/postMarketPrice: the user asked the journal not to
 * surface extended-hours prices.
 */
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

    const previousClose = finite(meta?.chartPreviousClose ?? meta?.regularMarketPreviousClose);
    const stamp = meta?.regularMarketTime ?? result?.timestamp?.at?.(-1);
    return {
      price,
      previousClose,
      change: previousClose != null ? price - previousClose : null,
      dailyPercent: previousClose ? (price - previousClose) / previousClose : null,
      date: stamp ? new Date(stamp * 1000).toISOString().slice(0, 10) : null,
      datetime: stamp ? new Date(stamp * 1000).toISOString() : null,
      name: meta?.longName ?? meta?.shortName ?? null,
      exchange: meta?.exchangeName ?? meta?.fullExchangeName ?? null,
      open: finite(meta?.regularMarketOpen),
      high: finite(meta?.regularMarketDayHigh),
      low: finite(meta?.regularMarketDayLow),
      volume: finite(meta?.regularMarketVolume),
      averageVolume: null,
      isMarketOpen: null,
      fiftyTwoWeek: null,
    };
  },
};

export const PROVIDERS = { stooq, yahoo, twelveData };
// Backward-compatible generic default. The product UI explicitly supplies
// defaultProviders(), whose order is Twelve Data -> Yahoo.
export const DEFAULT_PROVIDERS = [stooq, yahoo];

export function defaultProviders(apiKey = getTwelveDataKey()) {
  const key = String(apiKey ?? '').trim();
  return key ? [twelveData(key), yahoo] : [yahoo];
}

/**
 * Fetch one snapshot. A provider failure is quiet at the UI layer; after every
 * configured provider fails, callers retain the last saved price and can fall
 * through to manual entry.
 */
export async function fetchQuote(
  ticker,
  {
    provider = null,
    providers = null,
    apiKey = getTwelveDataKey(),
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
  } = {}
) {
  const attempts = provider ? [provider] : providers ?? DEFAULT_PROVIDERS;
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
/* Compatibility helpers                                               */
/* ------------------------------------------------------------------ */

// Still exported because older tests / saved code may import it, but the app no
// longer calls it. Price refreshes are now event-driven, never boot-driven.
export const AUTO_UPDATE_MIN_AGE_MIN = 30;
export function shouldAutoUpdate({ enabled, lastRunAt, now = new Date(), minAgeMin = AUTO_UPDATE_MIN_AGE_MIN }) {
  if (!enabled) return { update: false, reason: 'auto-update is off' };
  if (!lastRunAt) return { update: true, reason: 'never run' };
  const ageMin = (new Date(now) - new Date(lastRunAt)) / 60000;
  return ageMin >= minAgeMin
    ? { update: true, reason: `${Math.floor(ageMin)} minutes since the last check` }
    : { update: false, reason: 'checked recently' };
}

export function priceAge(entry, now = new Date()) {
  if (!entry?.at) return null;
  const hours = (new Date(now) - new Date(entry.at)) / 3600000;
  if (hours < 20) return { level: 'fresh', label: 'today', hours };
  if (hours < 96) return { level: 'ok', label: `${Math.round(hours / 24)}d ago`, hours };
  return { level: 'stale', label: `${Math.round(hours / 24)}d ago`, hours };
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

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

export function summarize(results) {
  const { updated, failed } = results;
  if (!updated.length && !failed.length) return 'Nothing to update';
  if (!failed.length) return `Updated ${updated.length} price${updated.length === 1 ? '' : 's'}`;
  if (!updated.length) return `Could not reach the price source — ${failed[0].error}`;
  return `Updated ${updated.length}, ${failed.length} failed`;
}
