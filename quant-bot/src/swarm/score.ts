import type { Candle } from '../domain/types.ts';
import { buildSwarm, forecastAt, type SwarmConfig, DEFAULT_SWARM } from './swarm.ts';

/**
 * Scores probability forecasts against what actually happened.
 *
 * Brier score is the mean squared error of the probability: 0 is perfect,
 * 0.25 is what "always say 50%" scores. A forecaster only has skill if it
 * beats the baselines a person gets for free — the coin flip, and the
 * historical up-rate — by more than chance would explain.
 */
export interface ScoredForecast {
  readonly t: number;
  readonly p: number;
  /** Trailing historical up-rate at t: the free baseline. */
  readonly baseRate: number;
  readonly up: boolean;
}

export interface CalibrationBucket {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly meanP: number;
  readonly actualUpRate: number;
}

export interface Scorecard {
  readonly n: number;
  readonly brier: number;
  readonly brierCoinFlip: number;
  readonly brierBaseRate: number;
  /** 1 - brier / baseline. Positive = better than the baseline. */
  readonly skillVsCoinFlip: number;
  readonly skillVsBaseRate: number;
  /**
   * t-statistic of the per-forecast Brier improvement over the base rate.
   * Around 2 or more is the conventional bar for "probably not luck".
   */
  readonly tStatVsBaseRate: number;
  /** How often the side the swarm favoured (p > 0.5 vs < 0.5) was right. */
  readonly directionalHitRate: number;
  readonly directionalCalls: number;
  readonly calibration: readonly CalibrationBucket[];
}

export function score(forecasts: readonly ScoredForecast[]): Scorecard {
  const n = forecasts.length;
  if (n === 0) throw new RangeError('nothing to score');
  const outcome = (f: ScoredForecast): number => (f.up ? 1 : 0);
  const brierOf = (p: number, f: ScoredForecast): number => (p - outcome(f)) ** 2;

  const diffs = forecasts.map((f) => brierOf(f.baseRate, f) - brierOf(f.p, f));
  const brier = mean(forecasts.map((f) => brierOf(f.p, f)));
  const brierCoinFlip = mean(forecasts.map((f) => brierOf(0.5, f)));
  const brierBaseRate = mean(forecasts.map((f) => brierOf(f.baseRate, f)));
  const meanDiff = mean(diffs);
  const sd = Math.sqrt(mean(diffs.map((d) => (d - meanDiff) ** 2)) * (n / Math.max(n - 1, 1)));
  const calls = forecasts.filter((f) => f.p !== 0.5);
  const hits = calls.filter((f) => (f.p > 0.5) === f.up).length;

  const edges = [0, 0.4, 0.45, 0.5, 0.55, 0.6, 1.0001];
  const calibration: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    const inBucket = forecasts.filter((f) => f.p >= lo && f.p < hi);
    if (inBucket.length === 0) continue;
    calibration.push({
      lo,
      hi: Math.min(hi, 1),
      n: inBucket.length,
      meanP: mean(inBucket.map((f) => f.p)),
      actualUpRate: mean(inBucket.map(outcome)),
    });
  }

  return {
    n,
    brier,
    brierCoinFlip,
    brierBaseRate,
    skillVsCoinFlip: 1 - brier / brierCoinFlip,
    skillVsBaseRate: 1 - brier / brierBaseRate,
    tStatVsBaseRate: sd > 0 ? meanDiff / (sd / Math.sqrt(n)) : 0,
    directionalHitRate: calls.length > 0 ? hits / calls.length : 0,
    directionalCalls: calls.length,
    calibration,
  };
}

export interface EvaluateOptions {
  readonly horizon: number;
  /**
   * Bars between forecasts. Defaults to the horizon: overlapping windows
   * share outcomes, which inflates the t-statistic without adding evidence.
   */
  readonly step?: number;
  readonly config?: SwarmConfig;
}

/**
 * Walk-forward: at each bar the swarm forecasts from bars 0..t only, and is
 * scored on bar t + horizon. The baseline gets the same information: the
 * up-rate over the same trailing window the swarm fits on.
 */
export function evaluateSwarm(candles: readonly Candle[], options: EvaluateOptions): { card: Scorecard; forecasts: ScoredForecast[] } {
  const config = options.config ?? DEFAULT_SWARM;
  const horizon = options.horizon;
  const step = options.step ?? horizon;
  const state = buildSwarm(candles, config);
  const forecasts: ScoredForecast[] = [];
  for (let t = state.warmup; t + horizon < candles.length; t += step) {
    const f = forecastAt(state, t, horizon);
    forecasts.push({
      t,
      p: f.pUp,
      baseRate: trailingUpRate(state.x, t, horizon, config.fitWindow),
      up: (state.x[t + horizon] as number) > (state.x[t] as number),
    });
  }
  return { card: score(forecasts), forecasts };
}

/** Share of past horizon-length moves that went up, using only moves completed by t. */
function trailingUpRate(x: readonly number[], t: number, horizon: number, window: number): number {
  let up = 0;
  let total = 0;
  for (let s = Math.max(0, t - window); s + horizon <= t; s += 1) {
    total += 1;
    if ((x[s + horizon] as number) > (x[s] as number)) up += 1;
  }
  return total > 0 ? up / total : 0.5;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, v) => a + v, 0) / values.length;
}
