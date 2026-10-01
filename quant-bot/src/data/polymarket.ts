import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarket, type ParsedMarket, type PricePoint } from '../research/polymarket.ts';

/**
 * Read-only access to Polymarket's public APIs: the Gamma API for resolved
 * markets and the CLOB API for a token's price history. No key, no wallet and
 * no orders: nothing here can place a trade.
 */
export const GAMMA = 'https://gamma-api.polymarket.com';
export const CLOB = 'https://clob.polymarket.com';

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, fetcher: FetchLike): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetcher(url);
    if (response.ok) return response.json();
    // 429 and 5xx are the API asking us to slow down; anything else is a real error.
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`Polymarket returned HTTP ${response.status} for ${url.split('?')[0]}`);
  }
}

export async function fetchResolvedMarkets(options: {
  readonly count: number;
  readonly minVolume: number;
  readonly cacheDir: string;
  readonly fetcher?: FetchLike;
}): Promise<ParsedMarket[]> {
  const fetcher: FetchLike = options.fetcher ?? ((u) => fetch(u));
  const cachePath = join(options.cacheDir, `markets-${options.count}-${options.minVolume}.json`);
  try {
    return JSON.parse(await readFile(cachePath, 'utf8')) as ParsedMarket[];
  } catch {
    // not cached yet
  }
  const out: ParsedMarket[] = [];
  // Offset paging is capped by the API; the keyset cursor walks the whole list.
  let cursor: string | undefined;
  for (let page = 0; out.length < options.count && page < 200; page += 1) {
    const body = await getJson(
      `${GAMMA}/markets/keyset?closed=true&limit=500&order=volumeNum&ascending=false` +
        `${cursor ? `&after_cursor=${encodeURIComponent(cursor)}` : ''}`, fetcher,
    );
    const list = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['markets'] : undefined;
    if (!Array.isArray(list) || list.length === 0) break;
    for (const raw of list) {
      const market = parseMarket(raw);
      if (market !== null && market.volume >= options.minVolume) out.push(market);
    }
    // Ordered by volume, so once a page is entirely under the floor the rest is too.
    const last = list[list.length - 1] as Record<string, unknown>;
    if (Number(last['volumeNum'] ?? 0) < options.minVolume) break;
    const next = (body as Record<string, unknown>)['next_cursor'];
    if (typeof next !== 'string' || next === '') break;
    cursor = next;
  }
  const markets = out.slice(0, options.count);
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(markets), 'utf8');
  return markets;
}

/** Daily Yes-token prices; an empty list when the API has none for the market. */
export async function fetchPriceHistory(token: string, cacheDir: string, fetcher?: FetchLike): Promise<PricePoint[]> {
  const f: FetchLike = fetcher ?? ((u) => fetch(u));
  const path = join(cacheDir, `history-${token.slice(0, 24)}-${token.slice(-12)}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PricePoint[];
  } catch {
    // not cached yet
  }
  const body = await getJson(`${CLOB}/prices-history?market=${encodeURIComponent(token)}&interval=max&fidelity=1440`, f);
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['history'] : undefined;
  const history: PricePoint[] = Array.isArray(raw)
    ? raw.flatMap((r) => {
      const t = Number((r as Record<string, unknown>)['t']);
      const p = Number((r as Record<string, unknown>)['p']);
      return Number.isFinite(t) && Number.isFinite(p) ? [{ t, p }] : [];
    })
    : [];
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, JSON.stringify(history), 'utf8');
  return history;
}
