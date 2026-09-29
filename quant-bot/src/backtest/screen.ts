import type { Candle } from '../domain/types.ts';
import { mulberry32 } from './monte-carlo.ts';
import type { StrategyFactory } from '../strategy/types.ts';
import { walkForward, type WalkForwardOptions } from './walk-forward.ts';

/**
 * What a symbol has to show, on data its parameters never saw, before the
 * bot is allowed to trade it.
 */
export interface ScreenCriteria {
  /** Walk-forward efficiency: out-of-sample objective over in-sample. */
  readonly minEfficiency: number;
  /** Out-of-sample trades. Below this, any result is mostly luck. */
  readonly minTrades: number;
  /**
   * Folds the efficiency must be averaged over. On a young coin it can come
   * from a single fold, and a single fold at the 2.0 cap looks like the best
   * result in the screen while meaning almost nothing.
   */
  readonly minFolds: number;
}

export const DEFAULT_SCREEN: ScreenCriteria = { minEfficiency: 0.5, minTrades: 10, minFolds: 3 };

export interface ScreenRow {
  readonly symbol: string;
  readonly bars: number;
  readonly efficiency: number | null;
  readonly efficiencyFolds: number;
  readonly oosReturnPct: number | null;
  readonly oosMaxDrawdownPct: number | null;
  readonly oosTrades: number;
  readonly passed: boolean;
  /** Why it failed, or what it showed if it passed. */
  readonly reason: string;
}

/**
 * Walk-forward tests one symbol and applies the pass rule.
 *
 * A pass needs all three: the edge held up out of sample (efficiency), it
 * made money out of sample, and it traded often enough for either number to
 * mean something. Any one alone is how a lucky series gets through.
 */
export function screenSymbol(
  symbol: string,
  candles: readonly Candle[],
  factory: StrategyFactory,
  options: WalkForwardOptions,
  criteria: ScreenCriteria = DEFAULT_SCREEN,
): ScreenRow {
  let result;
  try {
    result = walkForward(candles, factory, options);
  } catch (error) {
    return failed(symbol, candles.length, `could not walk-forward: ${error instanceof Error ? error.message : String(error)}`);
  }
  const m = result.outOfSampleMetrics;
  const row = {
    symbol,
    bars: candles.length,
    efficiency: Number.isFinite(result.efficiency) ? result.efficiency : null,
    efficiencyFolds: result.efficiencyFolds,
    oosReturnPct: m.totalReturnPct,
    oosMaxDrawdownPct: m.maxDrawdownPct,
    oosTrades: m.trades,
  };
  if (m.trades < criteria.minTrades) {
    return { ...row, passed: false, reason: `only ${m.trades} out-of-sample trades (need ${criteria.minTrades})` };
  }
  if (result.efficiencyFolds < criteria.minFolds) {
    return {
      ...row,
      passed: false,
      reason: `efficiency rests on ${result.efficiencyFolds} fold(s) (need ${criteria.minFolds})`,
    };
  }
  if (row.efficiency === null || row.efficiency < criteria.minEfficiency) {
    return { ...row, passed: false, reason: `efficiency ${fmt(row.efficiency)} < ${criteria.minEfficiency}: curve fit` };
  }
  if (m.totalReturnPct <= 0) {
    return { ...row, passed: false, reason: `lost ${m.totalReturnPct.toFixed(2)}% out of sample` };
  }
  return { ...row, passed: true, reason: `efficiency ${fmt(row.efficiency)}, +${m.totalReturnPct.toFixed(2)}% out of sample` };
}

export function failed(symbol: string, bars: number, reason: string): ScreenRow {
  return {
    symbol, bars, efficiency: null, efficiencyFolds: 0, oosReturnPct: null, oosMaxDrawdownPct: null, oosTrades: 0, passed: false, reason,
  };
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2);
}

/**
 * The same bars in a random order: every day's size and shape is kept, but
 * any trend, momentum or reversal across days is destroyed. Screening
 * shuffled markets measures how many passes the screen hands out to luck.
 */
export function shuffleBars(candles: readonly Candle[], seed: number): Candle[] {
  if (candles.length < 2) return [...candles];
  const first = candles[0] as Candle;
  // Each bar relative to the close before it, so bars can move independently.
  const relative = candles.slice(1).map((c, i) => {
    const prev = (candles[i] as Candle).close;
    return { open: c.open / prev, high: c.high / prev, low: c.low / prev, close: c.close / prev, volume: c.volume };
  });
  const rand = mulberry32(seed);
  for (let i = relative.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [relative[i], relative[j]] = [relative[j] as typeof relative[number], relative[i] as typeof relative[number]];
  }
  const out: Candle[] = [first];
  let prevClose = first.close;
  relative.forEach((r, i) => {
    const bar = {
      time: (candles[i + 1] as Candle).time,
      open: r.open * prevClose,
      high: r.high * prevClose,
      low: r.low * prevClose,
      close: r.close * prevClose,
      volume: r.volume,
    };
    out.push(bar);
    prevClose = bar.close;
  });
  return out;
}
