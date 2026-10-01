const DAY_MS = 86_400_000;

/**
 * Free exchange inflow and outflow, from Coin Metrics' community API (no key).
 * It is the free stand-in for Arkham's exchange netflow: Coin Metrics labels
 * the exchange addresses and publishes daily USD flows into and out of them.
 * Two differences matter when reading a result built on it:
 *   - it counts every transfer, not only whale-sized ones, and
 *   - the newest days are "flash" values that can be revised.
 * The free tier publishes these flows for BTC and ETH only, but with 15 and
 * 11 years of daily history, which is far more than a 1-day-lag paid feed.
 */
export const COINMETRICS_BASE = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';

export interface DayFlow {
  readonly day: number;
  readonly inflow: number;
  readonly outflow: number;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict: anything other than the documented shape stops with a message naming what arrived. */
export function parseFlows(body: unknown): DayFlow[] {
  if (!isRecord(body)) throw new Error(`unexpected Coin Metrics response: ${typeof body}`);
  if (isRecord(body['error'])) throw new Error(`Coin Metrics error: ${String(body['error']['message'] ?? 'unknown')}`);
  const data = body['data'];
  if (!Array.isArray(data)) throw new Error('unexpected Coin Metrics response: no "data" array');
  const out: DayFlow[] = [];
  for (const raw of data) {
    if (!isRecord(raw)) throw new Error('unexpected Coin Metrics row: not an object');
    const time = Date.parse(String(raw['time']));
    if (!Number.isFinite(time)) throw new Error(`unexpected Coin Metrics time: ${String(raw['time'])}`);
    const inRaw = raw['FlowInExUSD'];
    const outRaw = raw['FlowOutExUSD'];
    // A day with only one side published is unknown, not zero.
    if (inRaw === undefined || outRaw === undefined) continue;
    const inflow = Number(inRaw);
    const outflow = Number(outRaw);
    if (!Number.isFinite(inflow)) throw new Error(`unexpected FlowInExUSD: ${String(inRaw)}`);
    if (!Number.isFinite(outflow)) throw new Error(`unexpected FlowOutExUSD: ${String(outRaw)}`);
    out.push({ day: Math.floor(time / DAY_MS) * DAY_MS, inflow, outflow });
  }
  return out;
}

export interface Netflow {
  /** UTC day start to net USD sent onto exchanges that day (negative: off exchanges). */
  readonly flows: Map<number, number>;
  readonly covered: { readonly from: number; readonly to: number };
}

export function exchangeNetflow(days: readonly DayFlow[]): Netflow {
  const flows = new Map<number, number>();
  let from = Infinity;
  let to = -Infinity;
  for (const d of days) {
    flows.set(d.day, d.inflow - d.outflow);
    from = Math.min(from, d.day);
    to = Math.max(to, d.day + DAY_MS);
  }
  return { flows, covered: { from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : 0 } };
}

/** Pairs the free tier publishes exchange flows for. */
export function coinMetricsAsset(symbol: string): string {
  const base = symbol.split('/')[0]?.toUpperCase();
  if (base === 'BTC') return 'btc';
  if (base === 'ETH') return 'eth';
  throw new Error(`Coin Metrics' free tier has exchange flows for only BTC and ETH, not ${symbol}`);
}

export async function fetchExchangeNetflow(
  asset: string,
  options: { readonly startTime: string; readonly fetcher?: FetchLike; readonly baseUrl?: string },
): Promise<Netflow> {
  const fetcher: FetchLike = options.fetcher ?? ((url) => fetch(url));
  let url: string | undefined = options.baseUrl ??
    `${COINMETRICS_BASE}?assets=${encodeURIComponent(asset)}&metrics=FlowInExUSD,FlowOutExUSD&frequency=1d` +
    `&start_time=${encodeURIComponent(options.startTime)}&page_size=10000`;
  const days: DayFlow[] = [];
  // A page cap stops a looping next-page link from running forever.
  for (let page = 0; url !== undefined && page < 50; page += 1) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`Coin Metrics returned HTTP ${response.status}`);
    const body = await response.json();
    days.push(...parseFlows(body));
    const next = isRecord(body) ? body['next_page_url'] : undefined;
    url = typeof next === 'string' ? next : undefined;
  }
  return exchangeNetflow(days);
}
