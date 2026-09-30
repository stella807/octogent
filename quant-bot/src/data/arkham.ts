import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Candle } from '../domain/types.ts';

/**
 * Whale flows from Arkham Intelligence (intel.arkm.com): large transfers of a
 * token, labelled by who sent and received them. The one reading used here is
 * the classic exchange-flow signal: whales moving coins ONTO exchanges are
 * usually getting ready to sell; moving them OFF usually means holding. It is
 * a hypothesis like any other, tested through the same walk-forward and fleet
 * vote before any bot relies on it.
 *
 * The API needs a key, read only from ARKHAM_API_KEY and sent as a header,
 * so it never lands in a URL, a log, shell history or `ps` output.
 *
 * The response format was written from Arkham's documentation without a key
 * to confirm it against, so parsing is strict: anything unexpected stops with
 * an error naming what arrived, instead of quietly becoming zeros that would
 * look like "no whales" to a strategy. `whales` shows the first real response.
 */
export const ARKHAM_BASE = 'https://api.arkhamintelligence.com';
export const ARKHAM_KEY_ENV = 'ARKHAM_API_KEY';

const DAY_MS = 86_400_000;

export interface WhaleTransfer {
  readonly time: number;
  readonly usd: number;
  readonly fromExchange: boolean;
  readonly toExchange: boolean;
}

/** Arkham labels centralized exchanges with entity type "cex". */
function isExchange(side: unknown): boolean {
  const entity = (side as { arkhamEntity?: { type?: unknown } } | null | undefined)?.arkhamEntity;
  return typeof entity?.type === 'string' && entity.type.toLowerCase() === 'cex';
}

function parseTime(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const t = /^\d+$/.test(raw) ? Number(raw) * (raw.length <= 10 ? 1000 : 1) : Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function parseTransfers(body: unknown): WhaleTransfer[] {
  const list = (body as { transfers?: unknown } | null)?.transfers;
  if (!Array.isArray(list)) {
    const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : String(body);
    throw new Error(`unexpected Arkham response: no "transfers" list (got: ${keys || 'nothing'})`);
  }
  const out: WhaleTransfer[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const time = parseTime(raw?.['blockTimestamp']);
    const usd = Number(raw?.['historicalUSD']);
    // An unreadable transfer is skipped, never counted as zero.
    if (time === null || !Number.isFinite(usd)) continue;
    out.push({ time, usd, fromExchange: isExchange(raw['fromAddress']), toExchange: isExchange(raw['toAddress']) });
  }
  return out;
}

/** Net USD whales moved onto exchanges per UTC day (negative: off exchanges). */
export function dailyExchangeNetflow(transfers: readonly WhaleTransfer[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of transfers) {
    // Exchange-to-exchange is internal shuffling; wallet-to-wallet never touches an order book.
    if (t.fromExchange === t.toExchange) continue;
    const day = Math.floor(t.time / DAY_MS) * DAY_MS;
    out.set(day, (out.get(day) ?? 0) + (t.toExchange ? t.usd : -t.usd));
  }
  return out;
}

/**
 * One value per candle: the PRIOR day's netflow, like the sentiment signal,
 * so a bar never sees transfers from hours it has not closed yet. A day inside
 * the fetched range with no whale transfer is a real zero; a day outside it is
 * unknown (null), which strategies treat as "no information".
 */
export function alignNetflow(
  candles: readonly Candle[],
  flows: ReadonlyMap<number, number>,
  covered: { readonly from: number; readonly to: number },
): (number | null)[] {
  return candles.map((c) => {
    const prior = Math.floor(c.time / DAY_MS) * DAY_MS - DAY_MS;
    if (prior < covered.from || prior + DAY_MS > covered.to) return null;
    return flows.get(prior) ?? 0;
  });
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function fetchWhaleTransfers(options: {
  readonly tokenId: string;
  readonly since: number;
  readonly until: number;
  /** Only transfers at least this large; whales, not noise. */
  readonly minUsd: number;
  readonly apiKey: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly fetchImpl?: FetchLike;
}): Promise<WhaleTransfer[]> {
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 100;
  const doFetch = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const out: WhaleTransfer[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      tokens: options.tokenId,
      usdGte: String(options.minUsd),
      timeGte: String(options.since),
      timeLte: String(options.until),
      sortKey: 'time',
      sortDir: 'asc',
      limit: String(pageSize),
      offset: String(page * pageSize),
    });
    const response = await doFetch(`${ARKHAM_BASE}/transfers?${params}`, { headers: { 'API-Key': options.apiKey } });
    if (!response.ok) {
      throw new Error(
        `Arkham transfers request failed: HTTP ${response.status}` +
        (response.status === 401 || response.status === 403 ? `. Check ${ARKHAM_KEY_ENV} holds a valid Arkham API key.` : ''),
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A Cloudflare challenge or maintenance page arrives as HTML with a 200.
      throw new Error('Arkham returned something that is not JSON (a Cloudflare check or maintenance page?); try again later');
    }
    const count = Array.isArray((body as { transfers?: unknown[] })?.transfers) ? (body as { transfers: unknown[] }).transfers.length : 0;
    out.push(...parseTransfers(body));
    if (count < pageSize) return out;
  }
  // A cut-off history would read as "whales went quiet" for the missing span.
  throw new Error(
    `more than ${maxPages} pages of transfers for ${options.tokenId}; raise --min-usd or shorten the range with --since`,
  );
}

/** Cached per token, range and threshold, so a backtest does not re-spend API quota. */
export async function loadWhaleFlows(options: {
  readonly tokenId: string;
  readonly since: number;
  readonly until: number;
  readonly minUsd: number;
  readonly cacheDir?: string;
}): Promise<{ flows: Map<number, number>; transfers: number }> {
  const apiKey = process.env[ARKHAM_KEY_ENV];
  const cachePath = join(options.cacheDir ?? 'data/cache', 'arkham',
    `${options.tokenId}-${options.minUsd}-${options.since}-${options.until}.json`);
  let transfers: WhaleTransfer[] | null = null;
  try {
    transfers = JSON.parse(await readFile(cachePath, 'utf8')) as WhaleTransfer[];
  } catch {
    // Not cached yet.
  }
  if (!transfers) {
    if (!apiKey) throw new Error(`whale data needs an Arkham API key in ${ARKHAM_KEY_ENV}; see README "Whale tracking"`);
    transfers = await fetchWhaleTransfers({ ...options, apiKey });
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(transfers), 'utf8');
  }
  return { flows: dailyExchangeNetflow(transfers), transfers: transfers.length };
}

/**
 * Arkham identifies tokens by CoinGecko-style ids. Only coins checked by hand
 * are listed; anything else needs --arkham-token rather than a guess, since a
 * wrong id would quietly return some other token's whales.
 */
const TOKEN_IDS: Readonly<Record<string, string>> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano',
  LINK: 'chainlink', UNI: 'uniswap', XLM: 'stellar', LTC: 'litecoin', AVAX: 'avalanche-2', DOT: 'polkadot',
  SHIB: 'shiba-inu', PEPE: 'pepe', BONK: 'bonk', WIF: 'dogwifcoin', FLOKI: 'floki', AAVE: 'aave',
  NEAR: 'near', ZEC: 'zcash', HBAR: 'hedera-hashgraph', ARB: 'arbitrum',
};

export function arkhamTokenId(symbol: string, override?: string): string {
  if (override) return override;
  const base = symbol.split('/')[0] ?? '';
  const id = TOKEN_IDS[base];
  if (!id) throw new Error(`no Arkham token id known for ${base}; pass it with --arkham-token (e.g. its CoinGecko id)`);
  return id;
}
