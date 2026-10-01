/**
 * Calibration of Polymarket prices: when a market priced Yes at p, how often
 * did Yes happen, after the cost of trading it?
 *
 * Every observation is a market looked at H days before its SCHEDULED end,
 * and only if it was still open then, so the price is one a trader could have
 * acted on. Anchoring on the resolution time instead would quietly select
 * markets that were about to resolve. Markets in the same event move together,
 * so errors are clustered by event: ten outcomes of one election are close to
 * one bet, not ten.
 */

const DAY = 86_400;

export interface ParsedMarket {
  readonly id: string;
  readonly question: string;
  readonly event: string;
  readonly yesToken: string;
  readonly yesWon: boolean;
  /** Scheduled end, epoch seconds. */
  readonly endTs: number;
  /** When it actually closed, epoch seconds, or null if unknown. */
  readonly closedTs: number | null;
  readonly volume: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function jsonArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function seconds(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isFinite(t) ? t / 1000 : null;
}

/** A cleanly resolved Yes/No market, or null. Anything ambiguous is skipped rather than guessed. */
export function parseMarket(raw: unknown): ParsedMarket | null {
  if (!isRecord(raw)) return null;
  const outcomes = jsonArray(raw['outcomes']);
  const prices = jsonArray(raw['outcomePrices']);
  const tokens = jsonArray(raw['clobTokenIds']);
  if (!outcomes || !prices || !tokens || outcomes.length !== 2 || prices.length !== 2 || tokens.length !== 2) return null;
  if (String(outcomes[0]).toLowerCase() !== 'yes' || String(outcomes[1]).toLowerCase() !== 'no') return null;
  const [py, pn] = prices.map(Number);
  const yesWon = py === 1 && pn === 0;
  const noWon = py === 0 && pn === 1;
  if (!yesWon && !noWon) return null;
  const endTs = seconds(raw['endDate']);
  if (endTs === null) return null;
  const events = Array.isArray(raw['events']) ? raw['events'] : [];
  const first = events[0];
  const id = String(raw['id'] ?? '');
  if (!id || typeof tokens[0] !== 'string') return null;
  return {
    id,
    question: String(raw['question'] ?? ''),
    event: isRecord(first) && first['id'] !== undefined ? String(first['id']) : id,
    yesToken: tokens[0],
    yesWon,
    endTs,
    closedTs: seconds(raw['closedTime']),
    volume: Number(raw['volumeNum'] ?? 0) || 0,
  };
}

export interface PricePoint {
  readonly t: number;
  readonly p: number;
}

/** The last price at or before `ts`, or null if there is none or it is older than `maxStaleSec`. */
export function priceAt(history: readonly PricePoint[], ts: number, maxStaleSec: number): number | null {
  let best: PricePoint | null = null;
  for (const point of history) {
    if (point.t <= ts && (best === null || point.t > best.t)) best = point;
  }
  return best !== null && ts - best.t <= maxStaleSec ? best.p : null;
}

export interface Observation {
  readonly market: string;
  readonly event: string;
  readonly endTs: number;
  readonly horizon: number;
  /** Yes price at the horizon. */
  readonly p: number;
  readonly y: 0 | 1;
  readonly volume: number;
}

const MAX_STALE_SEC = 2 * DAY;

export function buildObservations(market: ParsedMarket, history: readonly PricePoint[], horizons: readonly number[]): Observation[] {
  const out: Observation[] = [];
  for (const horizon of horizons) {
    const anchor = market.endTs - horizon * DAY;
    // Already closed by then: nobody could have traded it at that price.
    if (market.closedTs !== null && market.closedTs <= anchor) continue;
    const p = priceAt(history, anchor, MAX_STALE_SEC);
    if (p === null) continue;
    out.push({ market: market.id, event: market.event, endTs: market.endTs, horizon, p, y: market.yesWon ? 1 : 0, volume: market.volume });
  }
  return out;
}

const EDGES = [0.01, 0.05, 0.15, 0.35, 0.65, 0.85, 0.95, 0.99];

/** Yes-price bucket 0..6, or null outside 1-99 cents where the price leaves no room to pay a cost and profit. */
export function bucketOf(p: number): number | null {
  for (let i = 0; i < EDGES.length - 1; i += 1) {
    if (p >= (EDGES[i] as number) && p < (EDGES[i + 1] as number)) return i;
  }
  return null;
}

export const bucketLabel = (b: number): string => `${Math.round((EDGES[b] as number) * 100)}-${Math.round((EDGES[b + 1] as number) * 100)}c`;

function normalCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26 via erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export interface Edge {
  readonly n: number;
  readonly clusters: number;
  readonly mean: number;
  readonly se: number;
  /** One-sided: the chance of a mean this high if the true edge were zero or negative. */
  readonly p: number;
}

/** Mean gain per share with a cluster-robust standard error (one cluster per event). */
export function clusterEdge(rows: readonly { readonly event: string; readonly gain: number }[]): Edge {
  const n = rows.length;
  const sums = new Map<string, number>();
  let total = 0;
  for (const r of rows) total += r.gain;
  const mean = n > 0 ? total / n : 0;
  for (const r of rows) sums.set(r.event, (sums.get(r.event) ?? 0) + (r.gain - mean));
  const clusters = sums.size;
  if (clusters < 2) return { n, clusters, mean, se: Infinity, p: 1 };
  let ss = 0;
  for (const s of sums.values()) ss += s * s;
  const se = Math.sqrt((ss * clusters) / (clusters - 1)) / n;
  const t = se > 0 ? mean / se : mean > 0 ? Infinity : 0;
  return { n, clusters, mean, se, p: 1 - normalCdf(t) };
}

export function splitByTime<T extends { readonly endTs: number }>(obs: readonly T[]): { train: T[]; test: T[] } {
  const sorted = [...obs].sort((a, b) => a.endTs - b.endTs);
  const median = sorted[Math.floor(sorted.length / 2)]?.endTs ?? 0;
  return { train: sorted.filter((o) => o.endTs < median), test: sorted.filter((o) => o.endTs >= median) };
}

export type Side = 'yes' | 'no';

export interface BucketRow extends Edge {
  readonly horizon: number;
  readonly bucket: number;
  readonly side: Side;
  readonly avgPrice: number;
}

/** Gain per share of buying `side` at the quoted price plus `cost` (half-spread and fees, in dollars). */
export function evaluateBuckets(obs: readonly Observation[], cost: number): BucketRow[] {
  const groups = new Map<string, Observation[]>();
  for (const o of obs) {
    const b = bucketOf(o.p);
    if (b === null) continue;
    const key = `${o.horizon}:${b}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
  }
  const rows: BucketRow[] = [];
  for (const [key, list] of groups) {
    const [h, b] = key.split(':').map(Number) as [number, number];
    for (const side of ['yes', 'no'] as const) {
      const gains = list.map((o) => ({
        event: o.event,
        gain: side === 'yes' ? o.y - (o.p + cost) : (1 - o.y) - ((1 - o.p) + cost),
      }));
      const avgPrice = list.reduce((a, o) => a + (side === 'yes' ? o.p : 1 - o.p), 0) / list.length;
      rows.push({ ...clusterEdge(gains), horizon: h, bucket: b, side, avgPrice });
    }
  }
  return rows.sort((a, b) => a.horizon - b.horizon || a.bucket - b.bucket || a.side.localeCompare(b.side));
}

export interface RuleVerdict {
  readonly horizon: number;
  readonly bucket: number;
  readonly side: Side;
  readonly train: BucketRow;
  readonly test: BucketRow | null;
  readonly confirmed: boolean;
}

export interface Study {
  readonly markets: number;
  readonly observations: number;
  readonly trainEnd: number;
  readonly all: BucketRow[];
  readonly selected: RuleVerdict[];
  readonly testBar: number;
}

const MIN_CLUSTERS = 15;

/**
 * Choose rules on the earlier half, confirm them once on the later half. A
 * rule is selected when it earns after costs in the earlier half (one-sided
 * p < 0.05) with enough independent events, and confirmed only if it also
 * earns in the later half at a bar that tightens with the number selected.
 */
export function runStudy(obs: readonly Observation[], cost: number, marketCount: number): Study {
  const { train, test } = splitByTime(obs);
  const trainRows = evaluateBuckets(train, cost).filter((r) => r.clusters >= MIN_CLUSTERS);
  const testRows = evaluateBuckets(test, cost);
  const picked = trainRows.filter((r) => r.mean > 0 && r.p < 0.05);
  const testBar = 0.05 / Math.max(1, picked.length);
  const selected = picked.map((r): RuleVerdict => {
    const t = testRows.find((x) => x.horizon === r.horizon && x.bucket === r.bucket && x.side === r.side) ?? null;
    return {
      horizon: r.horizon, bucket: r.bucket, side: r.side, train: r, test: t,
      confirmed: t !== null && t.clusters >= MIN_CLUSTERS && t.mean > 0 && t.p < testBar,
    };
  });
  return {
    markets: marketCount,
    observations: obs.length,
    trainEnd: test[0]?.endTs ?? 0,
    all: evaluateBuckets(obs, cost),
    selected,
    testBar,
  };
}
