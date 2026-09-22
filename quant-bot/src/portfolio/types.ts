import type { Params } from '../strategy/types.ts';
import type { AlignedSeries } from './align.ts';

/**
 * A portfolio strategy answers a different question from a single-asset one:
 * not "in or out" but "how should this account be split right now".
 *
 * Weights are fractions of total equity, each in [0, 1]. They may sum to less
 * than 1 — holding cash is a position — but never to more than 1, because this
 * is spot with no leverage. The engine normalises anything that overshoots
 * rather than silently levering up.
 */
export interface PortfolioStrategy {
  readonly name: string;
  readonly params: Params;
  readonly warmup: number;
  /** Target weight per symbol at bar `i`, using bars `0..i` only. */
  weightsAt(i: number): readonly number[];
}

export interface PortfolioStrategyFactory {
  readonly name: string;
  readonly defaults: Params;
  readonly grid: Readonly<Record<string, readonly number[]>>;
  create(series: AlignedSeries, params: Params): PortfolioStrategy;
}
