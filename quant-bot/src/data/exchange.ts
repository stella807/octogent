import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Candle, Timeframe } from '../domain/types.ts';
import { TIMEFRAME_MS } from '../domain/types.ts';

export interface FetchOptions {
  readonly exchange: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Inclusive lower bound, epoch ms. Defaults to `bars` back from now. */
  readonly since?: number | undefined;
  /** Inclusive upper bound, epoch ms. Defaults to the last closed bar. */
  readonly until?: number | undefined;
  /** Maximum bars to fetch. Acts as a safety cap when a date range is given. */
  readonly bars: number;
  readonly cacheDir: string;
}

export const DEFAULT_FETCH: Omit<FetchOptions, 'symbol'> = {
  exchange: 'binance',
  timeframe: '1d',
  bars: 1500,
  cacheDir: 'data/cache',
};

/**
 * OHLCV history from a public exchange endpoint via ccxt. Read-only: no API key
 * is involved, because fetching candles never needs one and an unused key is
 * just a credential waiting to leak.
 *
 * Results are cached on disk because re-downloading the same three years of
 * daily bars on every backtest is how you get rate limited, and because a
 * pinned local file is what makes a reported result reproducible later.
 */
export async function fetchCandles(options: FetchOptions): Promise<Candle[]> {
  const cachePath = cacheFile(options);
  const cached = await readCache(cachePath);
  if (cached) return cached;

  const candles = await downloadCandles(options);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(candles), 'utf8');
  return candles;
}

async function downloadCandles(options: FetchOptions): Promise<Candle[]> {
  const ccxt = await importCcxt();
  const ExchangeClass = (ccxt as Record<string, unknown>)[options.exchange];
  if (typeof ExchangeClass !== 'function') {
    throw new Error(`ccxt has no exchange named "${options.exchange}"`);
  }
  const client = new (ExchangeClass as new (cfg: unknown) => CcxtExchange)({
    enableRateLimit: true,
  });

  const barMs = TIMEFRAME_MS[options.timeframe];
  const since = options.since ?? Date.now() - options.bars * barMs;
  const until = options.until ?? Number.POSITIVE_INFINITY;
  const candles: Candle[] = [];
  let cursor = since;
  const pageSize = 1000;
  // A symbol listed after `since` returns empty pages for the window before it
  // existed. Stopping there would report "no data" for every coin younger than
  // the requested history, so skip forward instead — bounded, so a genuinely
  // dead symbol still terminates.
  let emptyPages = 0;
  const maxEmptyPages = 40;

  while (candles.length < options.bars) {
    const page = await client.fetchOHLCV(options.symbol, options.timeframe, cursor, pageSize);
    if (page.length === 0) {
      if (candles.length > 0 || emptyPages >= maxEmptyPages) break;
      emptyPages += 1;
      cursor += pageSize * barMs;
      if (cursor > Date.now()) break;
      continue;
    }
    emptyPages = 0;
    for (const row of page) {
      const [time, open, high, low, close, volume] = row;
      if (time === undefined || close === undefined) continue;
      // Exchanges overlap pages and return the still-forming current bar; both
      // would corrupt a backtest, so drop anything not strictly newer.
      const last = candles[candles.length - 1];
      if (last && time <= last.time) continue;
      candles.push({
        time,
        open: open ?? 0,
        high: high ?? 0,
        low: low ?? 0,
        close,
        volume: volume ?? 0,
      });
    }
    const newest = candles[candles.length - 1];
    if (!newest || newest.time <= cursor) break;
    if (newest.time >= until) break;
    cursor = newest.time + barMs;
    if (cursor > Date.now()) break;
  }

  // The final bar is still open until its period elapses; trading on a partial
  // bar is a lookahead bug that only shows up in live trading.
  const cutoff = Math.min(Date.now() - barMs, until);
  return candles.filter((c) => c.time >= since && c.time <= cutoff).slice(0, options.bars);
}

interface CcxtExchange {
  fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<(number | undefined)[][]>;
}

async function importCcxt(): Promise<unknown> {
  try {
    return await import('ccxt');
  } catch (cause) {
    throw new Error(
      'ccxt is not installed. Run `pnpm add ccxt`, or use --csv / --synthetic to work offline.',
      { cause },
    );
  }
}

function cacheFile(options: FetchOptions): string {
  const safeSymbol = options.symbol.replace(/[^A-Za-z0-9]/g, '_');
  // The range is part of the key: caching 2021-2022 under the same name as
  // "last 1500 bars" would silently serve the wrong window on the next run.
  const range = options.since === undefined && options.until === undefined
    ? String(options.bars)
    : `${options.since ?? 'start'}-${options.until ?? 'now'}-${options.bars}`;
  return join(
    options.cacheDir,
    `${options.exchange}-${safeSymbol}-${options.timeframe}-${range}.json`,
  );
}

async function readCache(path: string): Promise<Candle[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Candle[]) : null;
  } catch {
    return null;
  }
}
