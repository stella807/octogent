import type { Candle, Position, Signal } from '../domain/types.ts';

export type Params = Readonly<Record<string, number>>;

/**
 * Optional side-channel data a strategy may read beyond price. Kept separate
 * from `Params` (plain numbers, used for grid search) and from `Candle`
 * (price only) so adding a new input type — sentiment today, on-chain data
 * or funding rates later — never touches the signature every existing
 * strategy already implements. `create` takes it as an optional third
 * parameter, so strategies that don't need it are unaffected.
 */
export interface StrategyContext {
  /** Aligned 1:1 with the candles passed to `create`; see `alignSentiment`. */
  readonly sentiment?: readonly (number | null)[];
}

/**
 * A strategy is bound to a candle array up front so indicators are computed
 * once, then asked for a decision bar by bar.
 *
 * The contract every implementation must honour: `signalAt(i, ...)` may read
 * `candles[0..i]` and nothing beyond. The indicator helpers are all causal, so
 * honouring it usually just means not indexing past `i`. `test/no-lookahead.test.ts`
 * enforces the contract by replaying each strategy on progressively truncated
 * data and asserting the signals are identical.
 */
export interface Strategy {
  readonly name: string;
  readonly params: Params;
  /** Bars of history required before `signalAt` returns anything but flat. */
  readonly warmup: number;
  signalAt(i: number, position: Position | null): Signal;
}

export interface StrategyFactory {
  readonly name: string;
  readonly defaults: Params;
  /**
   * Candidate values per parameter for walk-forward optimisation. Keep these
   * deliberately coarse: a fine grid over a short sample finds noise, not edge.
   */
  readonly grid: Readonly<Record<string, readonly number[]>>;
  create(candles: readonly Candle[], params: Params, context?: StrategyContext): Strategy;
}

export function param(params: Params, key: string, fallback: number): number {
  const value = params[key];
  return value === undefined ? fallback : value;
}
