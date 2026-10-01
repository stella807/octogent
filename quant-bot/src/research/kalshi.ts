import { clusterEdge, splitByTime, type Edge } from './polymarket.ts';

/**
 * Calibration of Kalshi prices (Coinbase's prediction markets run on Kalshi).
 * Unlike Polymarket's midpoints, Kalshi's history carries the bid and ask, so a
 * trade is filled at the real ask (Yes) or one minus the bid (No), plus
 * Kalshi's fee. Each market is looked at a fixed number of hours AFTER it
 * opened, which is known when you trade; anchoring on the close would pick
 * markets that were about to resolve, since many close early on the event.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface KalshiMarket {
  readonly ticker: string;
  readonly event: string;
  readonly series: string;
  readonly yesWon: boolean;
  readonly openTs: number;
  readonly closeTs: number;
  readonly volume: number;
}

export const seriesOf = (eventTicker: string): string => eventTicker.split('-')[0] ?? eventTicker;

const secs = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t / 1000 : null;
};

export function parseKalshiMarket(raw: unknown): KalshiMarket | null {
  if (!isRecord(raw)) return null;
  // Parlays ("multivariate" combos) have no history worth testing and swamp the settled list.
  if (raw['mve_collection_ticker']) return null;
  if (raw['market_type'] !== 'binary') return null;
  const result = raw['result'];
  if (result !== 'yes' && result !== 'no') return null;
  const openTs = secs(raw['open_time']);
  const closeTs = secs(raw['close_time']);
  const ticker = raw['ticker'];
  const event = raw['event_ticker'];
  if (openTs === null || closeTs === null || typeof ticker !== 'string' || typeof event !== 'string') return null;
  return {
    ticker, event, series: seriesOf(event), yesWon: result === 'yes', openTs, closeTs,
    volume: Number(raw['volume_fp'] ?? 0) || 0,
  };
}

export interface KalshiCandle {
  /** End of the hour, epoch seconds. */
  readonly t: number;
  readonly ask: number;
  readonly bid: number;
  readonly volume: number;
}

/** Hours that have both a closing ask and a closing bid; one-sided hours are not tradable and are dropped. */
export function parseKalshiCandles(body: unknown): KalshiCandle[] {
  if (!isRecord(body) || !Array.isArray(body['candlesticks'])) throw new Error('unexpected Kalshi response: no "candlesticks" array');
  const out: KalshiCandle[] = [];
  for (const c of body['candlesticks']) {
    if (!isRecord(c)) continue;
    const ask = isRecord(c['yes_ask']) ? Number(c['yes_ask']['close_dollars']) : NaN;
    const bid = isRecord(c['yes_bid']) ? Number(c['yes_bid']['close_dollars']) : NaN;
    const t = Number(c['end_period_ts']);
    if (Number.isFinite(ask) && Number.isFinite(bid) && Number.isFinite(t)) {
      out.push({ t, ask, bid, volume: Number(c['volume_fp'] ?? 0) || 0 });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Kalshi's taker fee per contract: 7% of price x (1 - price), rounded up to the cent. */
export function kalshiFee(price: number): number {
  return Math.ceil(0.07 * price * (1 - price) * 100 - 1e-9) / 100;
}

export interface KalshiObservation {
  readonly market: string;
  readonly event: string;
  readonly series: string;
  readonly endTs: number;
  readonly afterOpenHours: number;
  readonly ask: number;
  readonly bid: number;
  readonly y: 0 | 1;
}

const HOUR = 3600;
const MAX_SPREAD = 0.1;

export function buildKalshiObservations(market: KalshiMarket, candles: readonly KalshiCandle[], afterOpenHours: readonly number[]): KalshiObservation[] {
  const out: KalshiObservation[] = [];
  for (const h of afterOpenHours) {
    const anchor = market.openTs + h * HOUR;
    if (anchor >= market.closeTs) continue;
    let quote: KalshiCandle | null = null;
    for (const c of candles) if (c.t <= anchor) quote = c;
    if (quote === null || quote.ask - quote.bid > MAX_SPREAD || quote.ask <= quote.bid) continue;
    out.push({
      market: market.ticker, event: market.event, series: market.series, endTs: market.closeTs, afterOpenHours: h,
      ask: quote.ask, bid: quote.bid, y: market.yesWon ? 1 : 0,
    });
  }
  return out;
}

export type KalshiSide = 'yes' | 'no';

export interface KalshiRow extends Edge {
  readonly afterOpenHours: number;
  readonly bucket: number;
  readonly side: KalshiSide;
  readonly avgPrice: number;
}

const EDGES = [0.01, 0.05, 0.15, 0.35, 0.65, 0.85, 0.95, 0.99];
export const kalshiBucket = (mid: number): number | null => {
  for (let i = 0; i < EDGES.length - 1; i += 1) if (mid >= (EDGES[i] as number) && mid < (EDGES[i + 1] as number)) return i;
  return null;
};
export const kalshiBucketLabel = (b: number): string => `${Math.round((EDGES[b] as number) * 100)}-${Math.round((EDGES[b + 1] as number) * 100)}c`;

/** Gain per contract: pay the ask (Yes) or 1 - bid (No) plus the fee, receive $1 if right. */
export function evaluateKalshi(obs: readonly KalshiObservation[]): KalshiRow[] {
  const groups = new Map<string, KalshiObservation[]>();
  for (const o of obs) {
    const b = kalshiBucket((o.ask + o.bid) / 2);
    if (b === null) continue;
    const key = `${o.afterOpenHours}:${b}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
  }
  const rows: KalshiRow[] = [];
  for (const [key, list] of groups) {
    const [h, b] = key.split(':').map(Number) as [number, number];
    for (const side of ['yes', 'no'] as const) {
      const priced = list.map((o) => {
        const price = side === 'yes' ? o.ask : 1 - o.bid;
        const won = side === 'yes' ? o.y === 1 : o.y === 0;
        return { event: o.event, price, gain: (won ? 1 : 0) - price - kalshiFee(price) };
      });
      rows.push({
        ...clusterEdge(priced), afterOpenHours: h, bucket: b, side,
        avgPrice: priced.reduce((a, r) => a + r.price, 0) / priced.length,
      });
    }
  }
  return rows.sort((a, b) => a.afterOpenHours - b.afterOpenHours || a.bucket - b.bucket || a.side.localeCompare(b.side));
}

export interface KalshiVerdict {
  readonly afterOpenHours: number;
  readonly bucket: number;
  readonly side: KalshiSide;
  readonly train: KalshiRow;
  readonly test: KalshiRow | null;
  readonly confirmed: boolean;
}

const MIN_CLUSTERS = 15;

export function runKalshiStudy(obs: readonly KalshiObservation[]) {
  const { train, test } = splitByTime(obs);
  const trainRows = evaluateKalshi(train).filter((r) => r.clusters >= MIN_CLUSTERS);
  const testRows = evaluateKalshi(test);
  const picked = trainRows.filter((r) => r.mean > 0 && r.p < 0.05);
  const testBar = 0.05 / Math.max(1, picked.length);
  const selected = picked.map((r): KalshiVerdict => {
    const t = testRows.find((x) => x.afterOpenHours === r.afterOpenHours && x.bucket === r.bucket && x.side === r.side) ?? null;
    return {
      afterOpenHours: r.afterOpenHours, bucket: r.bucket, side: r.side, train: r, test: t,
      confirmed: t !== null && t.clusters >= MIN_CLUSTERS && t.mean > 0 && t.p < testBar,
    };
  });
  return { observations: obs.length, trainEnd: test[0]?.endTs ?? 0, all: evaluateKalshi(obs), selected, testBar };
}
