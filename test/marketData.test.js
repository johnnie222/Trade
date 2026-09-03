import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  stooq,
  yahoo,
  fetchQuote,
  updatePrices,
  shouldAutoUpdate,
  priceAge,
  summarize,
  ProviderError,
} from '../src/data/marketData.js';

const CSV = 'Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-08-28,22:00:03,231.5,234.2,230.8,233.4,41230000\n';
const YAHOO = JSON.stringify({
  chart: {
    result: [{
      meta: { regularMarketPrice: 234.5, regularMarketTime: 1787947200 },
      indicators: { quote: [{ close: [233.4, 234.5] }] },
    }],
  },
});

const ok = (body) => async () => ({ ok: true, status: 200, text: async () => body });

describe('parsing a quote', () => {
  test('reads the close and the date', () => {
    const q = stooq.parse(CSV, 'AAPL');
    assert.equal(q.price, 233.4);
    assert.equal(q.date, '2026-08-28');
    assert.equal(q.high, 234.2);
    assert.equal(q.volume, 41230000);
  });

  test('an unknown symbol answers N/D, not an error status', () => {
    const nd = 'Symbol,Date,Time,Open,High,Low,Close,Volume\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n';
    assert.throws(() => stooq.parse(nd, 'ZZZZ'), ProviderError);
  });

  test('an empty body is refused rather than parsed into nothing', () => {
    assert.throws(() => stooq.parse('', 'AAPL'), ProviderError);
    assert.throws(() => stooq.parse('Symbol,Date,Close\n', 'AAPL'), ProviderError);
  });

  test('the url is built from the ticker, lowercased', () => {
    assert.match(stooq.url('DELL'), /s=dell\.us/);
  });

  test('reads a Yahoo chart response', () => {
    const q = yahoo.parse(YAHOO, 'AAPL');
    assert.equal(q.price, 234.5);
  });
});

describe('fetching', () => {
  test('a good response yields a quote', async () => {
    const q = await fetchQuote('AAPL', { fetchImpl: ok(CSV) });
    assert.equal(q.price, 233.4);
  });

  test('a non-200 is reported with its status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(() => fetchQuote('AAPL', { fetchImpl }), /503/);
  });

  /**
   * The case this whole layer is written around: a browser refused by CORS
   * gets an opaque TypeError with nothing useful in it. The message has to be
   * written here, because the platform will not provide one.
   */
  test('a CORS rejection becomes a sentence a person can act on', async () => {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    await assert.rejects(() => fetchQuote('AAPL', { fetchImpl }), /Could not reach the price source/);
  });

  test('a hang is abandoned rather than left pending', async () => {
    const fetchImpl = (url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    await assert.rejects(() => fetchQuote('AAPL', { fetchImpl, timeoutMs: 10 }), /Timed out/);
  });
});

describe('the update queue', () => {
  test('fetches every ticker and reports progress', async () => {
    const seen = [];
    const results = await updatePrices(['AAPL', 'DELL'], {
      fetchImpl: ok(CSV),
      gapMs: 0,
      onProgress: (p) => seen.push(p.phase),
    });
    assert.equal(results.updated.length, 2);
    assert.equal(results.failed.length, 0);
    assert.equal(seen.at(-1), 'done');
  });

  test('one failure does not stop the run', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n === 1) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, text: async () => CSV };
    };
    const results = await updatePrices(['BAD', 'AAPL', 'DELL'], { fetchImpl, gapMs: 0 });
    assert.equal(results.failed.length, 1);
    assert.equal(results.failed[0].ticker, 'BAD');
    assert.equal(results.updated.length, 2, 'the rest still updated');
  });

  test('an empty list is not an error', async () => {
    const r = await updatePrices([], { fetchImpl: ok(CSV), gapMs: 0 });
    assert.equal(r.total, 0);
    assert.equal(summarize(r), 'Nothing to update');
  });

  test('the summary says what happened', async () => {
    assert.match(summarize({ updated: [{}, {}], failed: [] }), /Updated 2 prices/);
    assert.match(summarize({ updated: [{}], failed: [] }), /Updated 1 price$/);
    assert.match(summarize({ updated: [], failed: [{ error: 'blocked' }] }), /blocked/);
    assert.match(summarize({ updated: [{}], failed: [{}] }), /Updated 1, 1 failed/);
  });
});

describe('when to auto-update', () => {
  const now = new Date('2026-08-28T14:00:00Z');

  test('never when it is switched off', () => {
    assert.equal(shouldAutoUpdate({ enabled: false, lastRunAt: null, now }).update, false);
  });

  test('always on a first run', () => {
    assert.equal(shouldAutoUpdate({ enabled: true, lastRunAt: null, now }).update, true);
  });

  /**
   * Reopening the app three times in a minute should not mean three round trips
   * for an end-of-day number that will not change until tomorrow.
   */
  test('not again within half an hour', () => {
    const r = shouldAutoUpdate({ enabled: true, lastRunAt: '2026-08-28T13:50:00Z', now });
    assert.equal(r.update, false);
    assert.match(r.reason, /recently/);
  });

  test('yes once the window has passed', () => {
    assert.equal(shouldAutoUpdate({ enabled: true, lastRunAt: '2026-08-28T13:00:00Z', now }).update, true);
  });
});

describe('price freshness', () => {
  const now = new Date('2026-08-28T14:00:00Z');

  test('today', () => {
    const age = priceAge({ at: '2026-08-28T02:00:00Z' }, now);
    assert.equal(age.level, 'fresh');
    assert.equal(age.label, 'today');
  });

  test('a couple of days is worth showing but not flagging', () => {
    const age = priceAge({ at: '2026-08-26T14:00:00Z' }, now);
    assert.equal(age.level, 'ok');
    assert.equal(age.label, '2d ago');
  });

  test('a week is flagged', () => {
    assert.equal(priceAge({ at: '2026-08-21T14:00:00Z' }, now).level, 'stale');
  });

  test('no price means no age, rather than a fake one', () => {
    assert.equal(priceAge(null), null);
    assert.equal(priceAge({}), null);
  });
});
