import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/data/csv.ts';
import { downloadCandles, fetchCandles, firstListedPage, type FetchOptions, type OhlcvSource } from '../src/data/exchange.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import type { Candle } from '../src/domain/types.ts';

describe('parseCsv', () => {
  it('accepts a header row and epoch-second timestamps', () => {
    const candles = parseCsv(`timestamp,open,high,low,close,volume
1704067200,100,110,90,105,12.5
1704153600,105,115,95,110,9`);
    expect(candles).toHaveLength(2);
    expect(candles[0]?.time).toBe(1_704_067_200_000);
    expect(candles[1]?.close).toBe(110);
  });

  it('accepts millisecond and ISO timestamps', () => {
    const ms = parseCsv('1704067200000,1,2,0.5,1.5,1');
    const iso = parseCsv('2024-01-01T00:00:00Z,1,2,0.5,1.5,1');
    expect(ms[0]?.time).toBe(iso[0]?.time);
  });

  it('sorts out-of-order rows so the engine never sees them backwards', () => {
    const candles = parseCsv(`1704153600,2,3,1,2,1
1704067200,1,2,0.5,1,1`);
    expect(candles[0]?.time).toBeLessThan(candles[1]?.time ?? 0);
  });

  it('rejects a row whose high is below its open, which would fake stop fills', () => {
    expect(() => parseCsv('1704067200,100,99,90,95,1')).toThrow(/inconsistent OHLC/);
  });

  it('rejects a row whose low is above its close', () => {
    expect(() => parseCsv('1704067200,100,110,101,100,1')).toThrow(/inconsistent OHLC/);
  });

  it('rejects non-numeric prices instead of silently producing NaN', () => {
    expect(() => parseCsv('1704067200,100,110,90,abc,1')).toThrow(/not a finite number/);
  });

  it('rejects short rows', () => {
    expect(() => parseCsv('1704067200,100,110,90')).toThrow(/expected 6 columns/);
  });

  it('ignores blank lines and comments', () => {
    const candles = parseCsv(`# exported from somewhere

1704067200,100,110,90,105,1
`);
    expect(candles).toHaveLength(1);
  });
});

describe('fetchCandles caching', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'quant-bot-cache-'));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  const baseOptions: Omit<FetchOptions, 'cacheDir'> = {
    exchange: 'coinbase',
    symbol: 'BTC/USD',
    timeframe: '1h',
    bars: 5,
  };

  function fakeDownload(candles: Candle[]) {
    let calls = 0;
    return {
      download: async () => {
        calls += 1;
        return candles;
      },
      calls: () => calls,
    };
  }

  const HOUR = 3_600_000;
  const NOW = 1_000 * HOUR;
  const candleAt = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });

  it('reuses a cache that already holds the latest closed bar', async () => {
    const first = fakeDownload([candleAt(NOW - HOUR)]);
    await fetchCandles({ ...baseOptions, cacheDir }, first.download, NOW);
    expect(first.calls()).toBe(1);

    // A second call with a *different* downloader must still return the cached
    // result and never invoke this one, proving the cache was actually hit.
    const second = fakeDownload([candleAt(NOW)]);
    const result = await fetchCandles({ ...baseOptions, cacheDir }, second.download, NOW);
    expect(second.calls()).toBe(0);
    expect(result[0]?.time).toBe(NOW - HOUR);
  });

  it('refreshes "latest N bars" once a newer bar has closed since it was cached', async () => {
    await fetchCandles({ ...baseOptions, cacheDir }, fakeDownload([candleAt(NOW - HOUR)]).download, NOW);

    const later = NOW + 5 * HOUR;
    const fresh = fakeDownload([candleAt(later - HOUR)]);
    const result = await fetchCandles({ ...baseOptions, cacheDir }, fresh.download, later);
    expect(fresh.calls()).toBe(1);
    expect(result[0]?.time).toBe(later - HOUR);
  });

  it('never refreshes an explicit date range, so pinned results stay reproducible', async () => {
    const pinned = { ...baseOptions, cacheDir, since: 0, until: 10 * HOUR };
    await fetchCandles(pinned, fakeDownload([candleAt(HOUR)]).download, NOW);

    const second = fakeDownload([candleAt(2 * HOUR)]);
    const result = await fetchCandles(pinned, second.download, NOW + 1_000 * HOUR);
    expect(second.calls()).toBe(0);
    expect(result[0]?.time).toBe(HOUR);
  });

  it('bypasses the cache with noCache: true, so a live poll always sees fresh data', async () => {
    const first = fakeDownload([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    await fetchCandles({ ...baseOptions, cacheDir, noCache: true }, first.download);

    // Same (exchange, symbol, timeframe, bars) key as a real live poll reuses —
    // must call the downloader again instead of returning the first result.
    const second = fakeDownload([{ time: 2, open: 2, high: 2, low: 2, close: 2, volume: 2 }]);
    const result = await fetchCandles({ ...baseOptions, cacheDir, noCache: true }, second.download);
    expect(second.calls()).toBe(1);
    expect(result[0]?.time).toBe(2);
  });
});

describe('downloading coins listed after the requested window starts', () => {
  const DAY = 86_400_000;
  const today = Math.floor(Date.now() / DAY) * DAY;

  /** Serves one fixed window per request, capped like a real exchange. */
  function exchange(listedDaysAgo: number | null, cap: number): OhlcvSource & { requests: number } {
    const src = {
      requests: 0,
      async fetchOHLCV(_s: string, _tf: string, since = 0, limit = 1000): Promise<(number | undefined)[][]> {
        src.requests += 1;
        if (listedDaysAgo === null) return [];
        const listed = today - listedDaysAgo * DAY;
        const rows: number[][] = [];
        for (let t = Math.max(since, listed); t < since + Math.min(limit, cap) * DAY && t <= today; t += DAY) {
          const aligned = Math.ceil(t / DAY) * DAY;
          if (aligned < since + Math.min(limit, cap) * DAY && aligned >= listed && aligned <= today) {
            rows.push([aligned, 1, 1, 1, 1, 1]);
          }
          t = aligned;
        }
        return rows;
      },
    };
    return src;
  }
  const options = { exchange: 'coinbase', symbol: 'NEW/USD', timeframe: '1d' as const, bars: 2000, cacheDir: '' };

  it('finds a coin listed 400 days ago on an exchange that caps pages at 300 bars', async () => {
    // The old fixed 1,000-bar skip jumped straight past this listing and
    // returned nothing, reporting the coin as having no data at all.
    const candles = await downloadCandles(options, exchange(400, 300));
    expect(candles[0]?.time).toBe(today - 400 * DAY);
    expect(candles.length).toBeGreaterThanOrEqual(398);
  });

  it('works whatever the page cap, including very small ones', async () => {
    const candles = await downloadCandles(options, exchange(1234, 100));
    expect(candles[0]?.time).toBe(today - 1234 * DAY);
  });

  it('returns nothing for a market with no trading at all, without paging forever', async () => {
    const src = exchange(null, 300);
    expect(await downloadCandles(options, src)).toEqual([]);
    expect(src.requests).toBeLessThanOrEqual(2);
  });

  it('locates the listing in a logarithmic number of requests', async () => {
    let requests = 0;
    const listed = 700;
    const found = await firstListedPage(async (cursor: number) => {
      requests += 1;
      return cursor + 300 > listed ? [cursor] : [];
    }, 0, 2000, 1);
    expect(found?.cursor).toBe(listed - 299);
    expect(requests).toBeLessThanOrEqual(13);
  });
});

describe('generateCandles', () => {
  it('is reproducible for a seed', () => {
    expect(generateCandles({ bars: 50, seed: 3 })).toEqual(generateCandles({ bars: 50, seed: 3 }));
  });

  it('produces internally consistent OHLC bars', () => {
    for (const c of generateCandles({ bars: 2000, seed: 5 })) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.low).toBeGreaterThan(0);
    }
  });

  it('advances time by exactly one bar interval', () => {
    const candles = generateCandles({ bars: 10, timeframe: '1h' });
    for (let i = 1; i < candles.length; i += 1) {
      expect((candles[i]?.time ?? 0) - (candles[i - 1]?.time ?? 0)).toBe(3_600_000);
    }
  });

  it('contains both up and down regimes, so strategies meet a bear market', () => {
    const candles = generateCandles({ bars: 2000, seed: 5 });
    const first = candles[0]?.close ?? 0;
    const closes = candles.map((c) => c.close);
    expect(Math.max(...closes)).toBeGreaterThan(first);
    expect(Math.min(...closes)).toBeLessThan(first);
  });
});
