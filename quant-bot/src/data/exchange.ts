import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TIMEFRAME_MS, type Candle, type Timeframe } from '../domain/types.ts';

export interface FetchOptions {
  readonly exchange: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Bars wanted. With `since`, a minimum; without it, the most recent N. */
  readonly bars: number;
  readonly since?: number | undefined;
  readonly until?: number | undefined;
  /** Where fetched history is kept between runs. Omit to skip the cache. */
  readonly cacheDir?: string | undefined;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Most exchanges cap a single OHLCV request somewhere between 300 and 1500. */
const PAGE_LIMIT = 500;
/** Guards against an exchange that keeps returning the same page. */
const MAX_PAGES = 1000;

/**
 * Closed OHLCV bars from any ccxt exchange, paginated forward from the start
 * of the window and cached on disk so re-running a backtest does not re-pull
 * years of history.
 *
 * The still-forming bar is always dropped: its close is a price that has not
 * happened yet, and trading on it is lookahead that no backtest would catch.
 */
export async function fetchCandles(options: FetchOptions): Promise<Candle[]> {
  const barMs = TIMEFRAME_MS[options.timeframe];
  const now = (options.now ?? Date.now)();
  const lastClosedOpen = Math.floor(now / barMs) * barMs - barMs;
  const end = Math.min(options.until ?? lastClosedOpen, lastClosedOpen);
  const start = options.since ?? end - (options.bars - 1) * barMs;

  const cachePath = options.cacheDir ? join(options.cacheDir, cacheName(options)) : undefined;
  const cached = cachePath ? await readCache(cachePath) : [];
  const byTime = new Map(cached.map((c) => [c.time, c]));

  const first = cached[0]?.time;
  const last = cached.at(-1)?.time;
  // The cache is one contiguous run of bars, so only the missing tail (or all
  // of it, when the window starts before the cache does) needs the network.
  const covered = first !== undefined && last !== undefined && first <= start;
  if (!covered || (last ?? 0) < end) {
    const from = covered && last !== undefined ? last + barMs : start;
    const client = await connect(options.exchange);
    for (const candle of await paginate(client, options.symbol, options.timeframe, from, end)) {
      byTime.set(candle.time, candle);
    }
  }

  const merged = [...byTime.values()]
    .filter((c) => c.time <= lastClosedOpen)
    .sort((a, b) => a.time - b.time);
  if (cachePath && merged.length > 0) await writeCache(cachePath, merged);

  const windowed = merged.filter((c) => c.time >= start && c.time <= end);
  return options.since === undefined ? windowed.slice(-options.bars) : windowed;
}

async function paginate(
  client: CcxtClient,
  symbol: string,
  timeframe: Timeframe,
  from: number,
  end: number,
): Promise<Candle[]> {
  const barMs = TIMEFRAME_MS[timeframe];
  const out: Candle[] = [];
  let cursor = from;
  for (let page = 0; page < MAX_PAGES && cursor <= end; page += 1) {
    const rows = await client.fetchOHLCV(symbol, timeframe, cursor, PAGE_LIMIT);
    const candles = rows.map(toCandle).filter((c): c is Candle => c !== null && c.time >= cursor);
    if (candles.length === 0) break;
    out.push(...candles);
    cursor = (candles.at(-1)?.time ?? end) + barMs;
  }
  return out;
}

function toCandle(row: readonly (number | undefined)[]): Candle | null {
  const [time, open, high, low, close, volume] = row;
  if ([time, open, high, low, close].some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return null;
  }
  return {
    time: time as number,
    open: open as number,
    high: high as number,
    low: low as number,
    close: close as number,
    volume: volume ?? 0,
  };
}

function cacheName(options: FetchOptions): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
  return `${safe(options.exchange)}_${safe(options.symbol)}_${options.timeframe}.json`;
}

async function readCache(path: string): Promise<Candle[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as Candle[]).sort((a, b) => a.time - b.time) : [];
  } catch {
    // A missing or corrupt cache just means fetching again.
    return [];
  }
}

async function writeCache(path: string, candles: readonly Candle[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  // Write-then-rename so an interrupted run never leaves a truncated cache.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(candles));
  await rename(tmp, path);
}

interface CcxtClient {
  fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<(number | undefined)[][]>;
}

async function connect(exchange: string): Promise<CcxtClient> {
  let ccxt: Record<string, unknown>;
  try {
    ccxt = (await import('ccxt')) as unknown as Record<string, unknown>;
  } catch {
    throw new Error('fetching exchange data needs the optional ccxt dependency; run `pnpm install` or use --synthetic / --csv');
  }
  const ExchangeClass = ccxt[exchange];
  if (typeof ExchangeClass !== 'function') throw new Error(`ccxt has no exchange named "${exchange}"`);
  // Public market data only: no credentials are ever passed here.
  return new (ExchangeClass as new (cfg: unknown) => CcxtClient)({ enableRateLimit: true });
}
