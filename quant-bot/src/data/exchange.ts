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
  /**
   * Skips the on-disk cache entirely. A backtest wants a pinned, reproducible
   * snapshot; a live poll calls with the same (exchange, symbol, timeframe, bars)
   * key on every tick and needs the newest bar each time, so caching that call
   * would freeze it on whatever it first downloaded.
   */
  readonly noCache?: boolean;
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
export async function fetchCandles(
  options: FetchOptions,
  download: (options: FetchOptions) => Promise<Candle[]> = downloadCandles,
  now: number = Date.now(),
): Promise<Candle[]> {
  const cachePath = cacheFile(options);
  if (!options.noCache) {
    const cached = await readCache(cachePath);
    if (cached && !isStale(cached, options, now)) return cached;
  }

  const candles = await download(options);
  if (!options.noCache) {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(candles), 'utf8');
  }
  return candles;
}

export async function downloadCandles(options: FetchOptions, source?: OhlcvSource): Promise<Candle[]> {
  const client = source ?? await connect(options.exchange);

  const barMs = TIMEFRAME_MS[options.timeframe];
  const now = Date.now();
  const since = options.since ?? now - options.bars * barMs;
  const until = options.until ?? Number.POSITIVE_INFINITY;
  const pageSize = 1000;
  const probe = (cursor: number): Promise<(number | undefined)[][]> =>
    withRetry(() => client.fetchOHLCV(options.symbol, options.timeframe, cursor, pageSize));

  let cursor = since;
  let page = await probe(cursor);
  if (page.length === 0) {
    // Nothing at the start of the window: the symbol was listed later (or
    // is not trading). Find where its history actually begins.
    const found = await firstListedPage(probe, since, Math.min(until, now - barMs), barMs);
    if (!found) return [];
    cursor = found.cursor;
    page = found.page;
  }

  const candles: Candle[] = [];
  for (;;) {
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
    if (candles.length >= options.bars) break;
    const newest = candles[candles.length - 1];
    if (!newest || newest.time <= cursor) break;
    if (newest.time >= until) break;
    cursor = newest.time + barMs;
    if (cursor > now) break;
    page = await probe(cursor);
    if (page.length === 0) break;
  }

  // The final bar is still open until its period elapses; trading on a partial
  // bar is a lookahead bug that only shows up in live trading.
  const cutoff = Math.min(Date.now() - barMs, until);
  return candles.filter((c) => c.time >= since && c.time <= cutoff).slice(0, options.bars);
}

interface CcxtMarket {
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  readonly spot?: boolean;
  readonly active?: boolean | null;
}

/** Stablecoin-vs-dollar pairs barely move; trend strategies have nothing to find there. */
const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'PYUSD', 'EURC', 'GUSD', 'USDS', 'FDUSD', 'TUSD', 'USDP', 'PAX']);

/**
 * Every tradable spot market on `exchange` quoted in `quote`, e.g. all
 * Coinbase USD pairs. Public endpoint; no API key involved.
 */
export async function listMarkets(exchange: string, quote: string): Promise<string[]> {
  const client = await connect(exchange);
  if (!client.loadMarkets) throw new Error(`ccxt ${exchange} cannot list markets`);
  const markets = await client.loadMarkets();
  return Object.values(markets)
    .filter((m) => m.spot !== false && m.active !== false && m.quote === quote && !STABLECOINS.has(m.base))
    .map((m) => m.symbol)
    .sort();
}

/** Anything that serves OHLCV pages the way ccxt's fetchOHLCV does. */
export interface OhlcvSource {
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<(number | undefined)[][]>;
}

/**
 * Finds the first non-empty page for a symbol listed after `from`.
 *
 * Stepping forward a fixed distance per empty page skips any listing that
 * falls between probes whenever the exchange returns fewer bars per request
 * than the step — Coinbase returns 300 of a requested 1,000, so every coin
 * listed in the 700 days each step jumped over came back as "no data". A page
 * is non-empty exactly when the listing lies within one page of its cursor,
 * so emptiness flips once as the cursor moves forward: a binary search finds
 * that point in about log2(window) requests, whatever the exchange's page cap.
 */
export async function firstListedPage<T>(
  probe: (cursor: number) => Promise<T[]>,
  from: number,
  to: number,
  barMs: number,
): Promise<{ cursor: number; page: T[] } | null> {
  if (to <= from) return null;
  const latest = await probe(to);
  // Nothing even in the most recent window: delisted or never traded.
  if (latest.length === 0) return null;
  let lo = from; // known empty
  let hi = to; // known non-empty
  let hiPage = latest;
  for (;;) {
    const steps = Math.floor((hi - lo) / barMs);
    if (steps < 2) break;
    const mid = lo + Math.floor(steps / 2) * barMs;
    const page = await probe(mid);
    if (page.length > 0) {
      hi = mid;
      hiPage = page;
    } else {
      lo = mid;
    }
  }
  return { cursor: hi, page: hiPage };
}

/**
 * One client per exchange for the life of the process. A fresh client reloads
 * the exchange's entire market list before its first request — 1.7s on
 * Coinbase, paid again for every symbol — and separate clients each run their
 * own rate limiter, so concurrent fetches could exceed the exchange's limit.
 */
const clients = new Map<string, Promise<CcxtExchange>>();

function connect(exchange: string): Promise<CcxtExchange> {
  let client = clients.get(exchange);
  if (!client) {
    client = (async () => {
      const ccxt = await importCcxt();
      const ExchangeClass = (ccxt as Record<string, unknown>)[exchange];
      if (typeof ExchangeClass !== 'function') {
        throw new Error(`ccxt has no exchange named "${exchange}"`);
      }
      return new (ExchangeClass as new (cfg: unknown) => CcxtExchange)({ enableRateLimit: true });
    })();
    // A failed connection must not be cached, or every later call inherits it.
    client.catch(() => clients.delete(exchange));
    clients.set(exchange, client);
  }
  return client;
}

/** ccxt error classes that mean "try again shortly", not "this request is wrong". */
const TRANSIENT = new Set(['RateLimitExceeded', 'DDoSProtection', 'RequestTimeout', 'NetworkError', 'ExchangeNotAvailable']);

/**
 * Retries throttling and network failures with backoff. Without this, one
 * 429 during a screen of hundreds of markets silently turns a market into
 * "no data" and drops it from the results.
 */
export async function withRetry<T>(
  request: () => Promise<T>,
  attempts = 4,
  delayMs = 1_000,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const kind = error instanceof Error ? error.constructor.name : '';
      if (attempt >= attempts || !TRANSIENT.has(kind)) throw error;
      await wait(delayMs * 2 ** (attempt - 1));
    }
  }
}

interface CcxtExchange extends OhlcvSource {
  loadMarkets?(): Promise<Record<string, CcxtMarket>>;
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

/**
 * An explicit range is a pinned, reproducible window and never goes stale.
 * "The latest N bars" does: once a newer bar has closed, serving the cached
 * copy silently reports results that are days or weeks old as current.
 */
function isStale(cached: readonly Candle[], options: FetchOptions, now: number): boolean {
  if (options.until !== undefined || options.since !== undefined) return false;
  const newest = cached[cached.length - 1];
  if (!newest) return true;
  // The most recent closed bar opened no earlier than two intervals ago.
  return newest.time < now - 2 * TIMEFRAME_MS[options.timeframe];
}

async function readCache(path: string): Promise<Candle[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Candle[]) : null;
  } catch {
    return null;
  }
}
