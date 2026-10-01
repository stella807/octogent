import type { Candle } from '../domain/types.ts';
import { screenSymbol } from '../backtest/screen.ts';
import type { WalkForwardOptions } from '../backtest/walk-forward.ts';
import { STRATEGIES } from '../strategy/index.ts';
import type { Params, StrategyFactory } from '../strategy/types.ts';

/**
 * Does an on-chain signal help trend-hold, beyond what the same signal does
 * when it is deliberately misaligned with the prices?
 *
 * The control rotates the flow series by many offsets (at least 90 days), so
 * every shifted run has the same flows, the same gaps and the same
 * autocorrelation, and only the link to the price path is cut. If the real
 * alignment beats most of them, the timing carries information; if it lands
 * in the middle of the pack, the filter's result was luck.
 */

export function rotate<T>(values: readonly T[], by: number): T[] {
  const n = values.length;
  if (n === 0) return [];
  const k = ((by % n) + n) % n;
  return [...values.slice(n - k), ...values.slice(0, n - k)];
}

/** The strategy at fixed parameters: no in-sample re-tuning, so no tuning luck to hide behind. */
export function fixedParams(factory: StrategyFactory, params: Params): StrategyFactory {
  return { ...factory, defaults: { ...factory.defaults, ...params }, grid: {} };
}

const MIN_SHIFT = 90;

export interface FlowEdge {
  readonly market: string;
  /** Out-of-sample return of plain trend-hold, percent. */
  readonly plain: number;
  /** ... with the whale filter on the real flows. */
  readonly real: number;
  /** ... with the filter on each rotated copy of the flows. */
  readonly shifted: number[];
  readonly offsets: number[];
  /** Share of rotated runs that did at least as well as the real one (one-sided, smoothed). */
  readonly p: number;
  readonly realTrades: number;
}

export function flowEdge(
  market: string,
  candles: readonly Candle[],
  flow: readonly (number | null)[],
  options: WalkForwardOptions,
  params: Params,
  shifts = 40,
): FlowEdge {
  const plainF = fixedParams(STRATEGIES['trend-hold'] as StrategyFactory, {});
  const whaleF = fixedParams(STRATEGIES['trend-hold-whales'] as StrategyFactory, params);
  const plain = screenSymbol(market, candles, plainF, options);
  const real = screenSymbol(market, candles, whaleF, { ...options, context: { whaleNetflow: [...flow] } });
  const span = candles.length - 2 * MIN_SHIFT;
  const offsets: number[] = [];
  const shifted: number[] = [];
  for (let s = 0; s < shifts; s += 1) {
    const offset = MIN_SHIFT + Math.floor((s + 0.5) * span / shifts);
    offsets.push(offset);
    const r = screenSymbol(market, candles, whaleF, { ...options, context: { whaleNetflow: rotate(flow, offset) } });
    shifted.push(r.oosReturnPct ?? 0);
  }
  const realRet = real.oosReturnPct ?? 0;
  const atLeast = shifted.filter((v) => v >= realRet).length;
  return {
    market, plain: plain.oosReturnPct ?? 0, real: realRet, shifted, offsets,
    p: (1 + atLeast) / (1 + shifts), realTrades: real.oosTrades,
  };
}
