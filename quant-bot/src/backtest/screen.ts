import type { Candle } from '../domain/types.ts';
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
}

export const DEFAULT_SCREEN: ScreenCriteria = { minEfficiency: 0.5, minTrades: 10 };

export interface ScreenRow {
  readonly symbol: string;
  readonly bars: number;
  readonly efficiency: number | null;
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
    oosReturnPct: m.totalReturnPct,
    oosMaxDrawdownPct: m.maxDrawdownPct,
    oosTrades: m.trades,
  };
  if (m.trades < criteria.minTrades) {
    return { ...row, passed: false, reason: `only ${m.trades} out-of-sample trades (need ${criteria.minTrades})` };
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
    symbol, bars, efficiency: null, oosReturnPct: null, oosMaxDrawdownPct: null, oosTrades: 0, passed: false, reason,
  };
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2);
}
