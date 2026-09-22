import type { Candle } from '../domain/types.ts';
import type { Params, StrategyFactory } from '../strategy/types.ts';
import { runBacktest, type BacktestConfig } from './engine.ts';
import { computeMetrics } from './metrics.ts';

/**
 * The honest version of "test thousands of strategies": split history ONCE
 * into a train period and a held-out test period, run every candidate
 * parameter combination on BOTH, and report the relationship between the two
 * -- across the whole set, not just whichever one candidate looked best.
 *
 * This is deliberately not walk-forward. Walk-forward already picks the
 * single best in-sample candidate per fold and reports only that one's
 * out-of-sample result, which answers "did the best strategy generalise."
 * This answers the more basic question a claim like "test 10,000 strategies"
 * is actually resting on: across a large population of candidates, does
 * doing better on training data predict doing better on data it never
 * touched, or is the in-sample ranking close to noise? If it is noise,
 * running more candidates does not find more edge -- it just makes it more
 * likely that some candidate got lucky on the training window, which is the
 * mechanism a large search space uses to manufacture a convincing-looking
 * result out of nothing.
 */
export interface SearchRow {
  readonly params: Params;
  readonly trainCalmar: number;
  readonly testCalmar: number;
  readonly trainTrades: number;
  readonly testTrades: number;
}

export interface SearchResult {
  readonly strategy: string;
  readonly candidatesTested: number;
  readonly candidatesSkipped: number;
  readonly trainBars: { readonly from: number; readonly to: number };
  readonly testBars: { readonly from: number; readonly to: number };
  readonly rows: readonly SearchRow[];
  /** Pearson correlation between train-period and test-period Calmar, across all candidates. */
  readonly trainTestCorrelation: number;
  readonly testCalmarPositiveFraction: number;
  readonly testCalmarPercentiles: { readonly p10: number; readonly p50: number; readonly p90: number };
  /** The candidate ranked #1 on TRAIN data, evaluated on test -- what "just pick the best one" gets you. */
  readonly bestOnTrain: SearchRow | null;
}

export interface SearchOptions {
  /** Fraction of usable history used for training; the rest is the untouched test period. */
  readonly trainRatio: number;
  readonly config: BacktestConfig;
  /** Caps runtime; a large grid is truncated to this many candidates (sampled evenly, not just the first N). */
  readonly maxCandidates: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  trainRatio: 0.6,
  config: { startingEquity: 10_000 } as BacktestConfig, // caller always supplies a real config
  maxCandidates: 10_000,
};

export function runSearch(
  candles: readonly Candle[],
  factory: StrategyFactory,
  grid: readonly Params[],
  options: SearchOptions,
): SearchResult {
  const warmup = factory.create(candles, factory.defaults).warmup;
  const usable = candles.length - warmup;
  if (usable < 60) {
    throw new RangeError(`not enough history to search: ${candles.length} bars leaves ${usable} after warmup`);
  }
  const splitAt = warmup + Math.floor(usable * options.trainRatio);
  const trainSlice = candles.slice(0, splitAt);
  // The test slice carries a warmup-length prefix so its own indicators are
  // primed, exactly like walk-forward's fold slicing -- otherwise the first
  // stretch of "test" bars would trade on under-warmed indicators, which
  // would not be a fair test of the strategy, just of its cold start.
  const testFrom = Math.max(0, splitAt - warmup);
  const testSlice = candles.slice(testFrom, candles.length);

  const candidates = sampleEvenly(grid, options.maxCandidates);
  const rows: SearchRow[] = [];
  let skipped = 0;

  for (const params of candidates) {
    let trainResult;
    let testResult;
    try {
      trainResult = runBacktest(trainSlice, factory.create(trainSlice, params), options.config);
      testResult = runBacktest(testSlice, factory.create(testSlice, params), options.config);
    } catch {
      skipped += 1; // an invalid parameter combination (e.g. fast >= slow)
      continue;
    }
    const trainMetrics = computeMetrics(trainResult);
    const testMetrics = computeMetrics(testResult);
    rows.push({
      params,
      trainCalmar: finiteOrZero(trainMetrics.calmar),
      testCalmar: finiteOrZero(testMetrics.calmar),
      trainTrades: trainMetrics.trades,
      testTrades: testMetrics.trades,
    });
  }

  const testCalmars = rows.map((r) => r.testCalmar).sort((a, b) => a - b);
  const bestOnTrain = rows.reduce<SearchRow | null>(
    (best, row) => (best === null || row.trainCalmar > best.trainCalmar ? row : best),
    null,
  );

  return {
    strategy: factory.name,
    candidatesTested: rows.length,
    candidatesSkipped: skipped,
    trainBars: { from: 0, to: splitAt },
    testBars: { from: testFrom, to: candles.length },
    rows,
    trainTestCorrelation: pearson(rows.map((r) => r.trainCalmar), rows.map((r) => r.testCalmar)),
    testCalmarPositiveFraction: rows.length > 0 ? rows.filter((r) => r.testCalmar > 0).length / rows.length : 0,
    testCalmarPercentiles: {
      p10: quantileOf(testCalmars, 0.1),
      p50: quantileOf(testCalmars, 0.5),
      p90: quantileOf(testCalmars, 0.9),
    },
    bestOnTrain,
  };
}

/** Picks up to `max` entries from `items`, spread evenly rather than truncated from the front. */
function sampleEvenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(items[Math.floor(i * step)] as T);
  }
  return out;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function quantileOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const meanX = x.reduce((a, v) => a + v, 0) / n;
  const meanY = y.reduce((a, v) => a + v, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (x[i] as number) - meanX;
    const dy = (y[i] as number) - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const denom = Math.sqrt(varX * varY);
  return denom > 0 ? cov / denom : 0;
}

/** Cartesian product over an arbitrary parameter grid, for building a large candidate set. */
export function expandFineGrid(grid: Readonly<Record<string, readonly number[]>>): Params[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];
  let combos: Params[] = [{}];
  for (const key of keys) {
    const values = grid[key] ?? [];
    const next: Params[] = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}

/** Builds an evenly-spaced numeric range, inclusive of both ends. */
export function range(from: number, to: number, step: number): number[] {
  if (step <= 0) throw new RangeError(`range step must be > 0, got ${step}`);
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
