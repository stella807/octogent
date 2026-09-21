import type { Candle, EquityPoint, Trade } from '../domain/types.ts';
import type { Params, StrategyFactory } from '../strategy/types.ts';
import { DEFAULT_CONFIG, runBacktest, type BacktestConfig, type BacktestResult } from './engine.ts';
import { computeMetrics, type Metrics } from './metrics.ts';

/**
 * Walk-forward analysis: the difference between a strategy that works and a
 * strategy that was fitted to the past.
 *
 * Tuning parameters on the same data you then report results on will make
 * almost any rule look profitable — that is where "$50 into $5000" screenshots
 * come from. Here, each fold picks its parameters using only bars that came
 * BEFORE the segment it is scored on, and only the out-of-sample segments are
 * stitched into the reported equity curve. The in-sample numbers are kept
 * purely so the report can show the gap between them, which is the honest
 * measure of how much of the "edge" was curve fitting.
 */
export type Objective = 'calmar' | 'sharpe' | 'sortino' | 'return' | 'profitFactor';

export interface WalkForwardOptions {
  readonly folds: number;
  /** Fraction of each fold's history used for parameter selection. */
  readonly inSampleRatio: number;
  readonly objective: Objective;
  /** Anchored keeps every past bar in-sample; rolling uses a fixed lookback. */
  readonly anchored: boolean;
  readonly config: BacktestConfig;
}

export const DEFAULT_WF_OPTIONS: WalkForwardOptions = {
  folds: 5,
  inSampleRatio: 0.7,
  objective: 'calmar',
  anchored: false,
  config: DEFAULT_CONFIG,
};

export interface Fold {
  readonly index: number;
  readonly inSample: { readonly from: number; readonly to: number };
  readonly outOfSample: { readonly from: number; readonly to: number };
  readonly chosenParams: Params;
  readonly inSampleMetrics: Metrics;
  readonly outOfSampleMetrics: Metrics;
  readonly candidatesTested: number;
}

export interface WalkForwardResult {
  readonly strategy: string;
  readonly folds: readonly Fold[];
  readonly stitchedEquity: readonly EquityPoint[];
  readonly stitchedTrades: readonly Trade[];
  readonly outOfSampleMetrics: Metrics;
  /**
   * Out-of-sample objective divided by in-sample objective, averaged over
   * folds. Below ~0.5 means most of the backtested edge did not survive
   * contact with unseen data.
   */
  readonly efficiency: number;
}

export function walkForward(
  candles: readonly Candle[],
  factory: StrategyFactory,
  options: WalkForwardOptions = DEFAULT_WF_OPTIONS,
): WalkForwardResult {
  const { folds: foldCount, inSampleRatio, config } = options;
  if (foldCount < 1) throw new RangeError(`folds must be >= 1, got ${foldCount}`);
  if (inSampleRatio <= 0 || inSampleRatio >= 1) {
    throw new RangeError(`inSampleRatio must be in (0, 1), got ${inSampleRatio}`);
  }

  const warmup = factory.create(candles, factory.defaults).warmup;
  const usable = candles.length - warmup;
  if (usable < foldCount * 20) {
    throw new RangeError(
      `not enough history: ${candles.length} bars leaves ${usable} after a ${warmup}-bar warmup, which cannot support ${foldCount} folds`,
    );
  }

  // Geometry: one training window of `inSampleRatio` of the usable history,
  // then `folds` contiguous out-of-sample windows that tile everything after
  // it. Stepping by the OOS length rather than by a whole fold matters — the
  // obvious alternative leaves untested gaps between folds, which quietly
  // turns "tested on 2000 bars" into "tested on 580 of them".
  const isLength = Math.floor(usable * inSampleRatio);
  const oosLength = Math.floor((usable - isLength) / foldCount);
  if (oosLength < 5) {
    throw new RangeError(
      `not enough out-of-sample history: ${usable - isLength} bars across ${foldCount} folds`,
    );
  }

  const grid = expandGrid(factory);
  const foldResults: Fold[] = [];

  let equity = config.startingEquity;
  const stitchedEquity: EquityPoint[] = [];
  const stitchedTrades: Trade[] = [];
  let efficiencySum = 0;
  let efficiencyCount = 0;

  for (let k = 0; k < foldCount; k += 1) {
    const isFrom = options.anchored ? warmup : warmup + k * oosLength;
    const isTo = warmup + isLength + k * oosLength;
    const oosFrom = isTo;
    const oosTo = k === foldCount - 1 ? candles.length : oosFrom + oosLength;
    if (oosTo - oosFrom < 5 || oosFrom >= candles.length) break;

    const isSlice = candles.slice(isFrom, isTo);
    // The out-of-sample slice carries a warmup prefix so indicators are primed,
    // but the engine refuses to trade during warmup, so no signal in the scored
    // region is ever derived from a bar the optimiser was allowed to see.
    const oosSlice = candles.slice(Math.max(0, oosFrom - warmup), oosTo);

    let best: { params: Params; score: number; result: BacktestResult } | null = null;
    for (const params of grid) {
      let result: BacktestResult;
      try {
        result = runBacktest(isSlice, factory.create(isSlice, params), config);
      } catch {
        continue; // invalid parameter combination (e.g. fast >= slow)
      }
      const score = selectionScore(computeMetrics(result), options.objective);
      if (best === null || score > best.score) best = { params, score, result };
    }
    if (best === null) continue;

    const oosConfig: BacktestConfig = { ...config, startingEquity: equity };
    const oosResult = runBacktest(oosSlice, factory.create(oosSlice, best.params), oosConfig);
    const oosMetrics = computeMetrics(oosResult);
    const isMetrics = computeMetrics(best.result);

    // Efficiency uses the unpenalised score: the small-sample sentinel used to
    // rank candidates would otherwise poison the ratio with an infinity.
    const isRaw = rawScore(isMetrics, options.objective);
    const oosRaw = rawScore(oosMetrics, options.objective);
    if (isRaw > 0) {
      efficiencySum += clamp(oosRaw / isRaw, -2, 2);
      efficiencyCount += 1;
    }

    // Only the scored region is stitched; the warmup prefix is dropped.
    const skip = oosFrom - Math.max(0, oosFrom - warmup);
    stitchedEquity.push(...oosResult.equityCurve.slice(skip));
    stitchedTrades.push(...oosResult.trades);
    equity = oosResult.endingEquity;

    foldResults.push({
      index: k,
      inSample: { from: isFrom, to: isTo },
      outOfSample: { from: oosFrom, to: oosTo },
      chosenParams: best.params,
      inSampleMetrics: isMetrics,
      outOfSampleMetrics: oosMetrics,
      candidatesTested: grid.length,
    });
  }

  const stitched: BacktestResult = {
    strategy: { name: factory.name, params: {} },
    config,
    equityCurve: stitchedEquity,
    trades: stitchedTrades,
    startingEquity: config.startingEquity,
    endingEquity: equity,
    firstHalt: null,
    barsTested: stitchedEquity.length,
  };

  return {
    strategy: factory.name,
    folds: foldResults,
    stitchedEquity,
    stitchedTrades,
    outOfSampleMetrics: computeMetrics(stitched),
    efficiency: efficiencyCount > 0 ? efficiencySum / efficiencyCount : 0,
  };
}

/** The objective value itself, with no sample-size penalty applied. */
export function rawScore(metrics: Metrics, objective: Objective): number {
  const raw = objective === 'calmar' ? metrics.calmar
    : objective === 'sharpe' ? metrics.sharpe
    : objective === 'sortino' ? metrics.sortino
    : objective === 'return' ? metrics.totalReturnPct
    : metrics.profitFactor;
  // Infinity here means "no losing trades yet", which is a sample-size
  // artefact rather than a perfect strategy, so it must not win a ranking.
  return Number.isFinite(raw) ? raw : 0;
}

/** Ranking score used to pick a fold's parameters. */
function selectionScore(metrics: Metrics, objective: Objective): number {
  // A handful of trades cannot distinguish edge from luck, whatever the ratio says.
  return metrics.trades < 5 ? Number.NEGATIVE_INFINITY : rawScore(metrics, objective);
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, lo), hi);
}

/** Cartesian product of the factory's parameter grid, merged over its defaults. */
export function expandGrid(factory: StrategyFactory): Params[] {
  const keys = Object.keys(factory.grid);
  if (keys.length === 0) return [factory.defaults];
  let combos: Params[] = [factory.defaults];
  for (const key of keys) {
    const values = factory.grid[key] ?? [];
    const next: Params[] = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}
