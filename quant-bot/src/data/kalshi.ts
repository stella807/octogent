import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mulberry32 } from '../backtest/monte-carlo.ts';
import { parseKalshiCandles, parseKalshiMarket, type KalshiCandle, type KalshiMarket } from '../research/kalshi.ts';

/**
 * Read-only access to Kalshi's public market-data API (the exchange behind
 * Coinbase's prediction markets). No key, no account and no orders: nothing
 * here can place a trade.
 */
export const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, fetcher: FetchLike): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetcher(url);
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`Kalshi returned HTTP ${response.status} for ${url.split('?')[0]}`);
  }
}

/**
 * Settled non-parlay markets that traded, sampled from `windows` random
 * one-hour windows of closing time in the last `days` days. Hour windows
 * matter: a whole day's list is dominated by thousands of untraded strikes
 * closing at the same second.
 */
export async function sampleSettledMarkets(options: {
  readonly days: number;
  readonly windows: number;
  readonly pagesPerWindow: number;
  readonly minVolume: number;
  readonly seed: number;
  readonly cacheDir: string;
  readonly now?: number;
  readonly fetcher?: FetchLike;
}): Promise<KalshiMarket[]> {
  const fetcher: FetchLike = options.fetcher ?? ((u) => fetch(u));
  const cachePath = join(options.cacheDir, `markets-${options.days}d-${options.windows}w-${options.pagesPerWindow}p-${options.minVolume}v-${options.seed}.json`);
  try {
    return JSON.parse(await readFile(cachePath, 'utf8')) as KalshiMarket[];
  } catch {
    // not cached yet
  }
  const rand = mulberry32(options.seed);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const horizon = now - 2 * 86_400; // leave settlement time
  const out = new Map<string, KalshiMarket>();
  for (let w = 0; w < options.windows; w += 1) {
    const start = Math.floor(horizon - rand() * options.days * 86_400);
    let cursor = '';
    for (let page = 0; page < options.pagesPerWindow; page += 1) {
      const body = await getJson(
        `${KALSHI}/markets?status=settled&limit=1000&mve_filter=exclude&min_close_ts=${start}&max_close_ts=${start + 3600}` +
          `${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, fetcher,
      );
      const list = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['markets'] : undefined;
      if (!Array.isArray(list) || list.length === 0) break;
      for (const raw of list) {
        const m = parseKalshiMarket(raw);
        if (m !== null && m.volume >= options.minVolume) out.set(m.ticker, m);
      }
      const next = (body as Record<string, unknown>)['cursor'];
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    await sleep(150);
  }
  const markets = [...out.values()];
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(markets), 'utf8');
  return markets;
}

/** Hourly bid/ask history from open to close (cached per ticker). */
export async function fetchKalshiCandles(market: KalshiMarket, cacheDir: string, fetcher?: FetchLike): Promise<KalshiCandle[]> {
  const f: FetchLike = fetcher ?? ((u) => fetch(u));
  const path = join(cacheDir, `candles-${market.ticker.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as KalshiCandle[];
  } catch {
    // not cached yet
  }
  const body = await getJson(
    `${KALSHI}/series/${encodeURIComponent(market.series)}/markets/${encodeURIComponent(market.ticker)}/candlesticks` +
      `?start_ts=${Math.floor(market.openTs)}&end_ts=${Math.ceil(market.closeTs)}&period_interval=60`, f,
  );
  const candles = parseKalshiCandles(body);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, JSON.stringify(candles), 'utf8');
  return candles;
}
