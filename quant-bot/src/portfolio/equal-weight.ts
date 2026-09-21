import { param, type Params } from '../strategy/types.ts';
import type { AlignedSeries } from './align.ts';
import type { PortfolioStrategy, PortfolioStrategyFactory } from './types.ts';

/**
 * Hold every symbol in equal weight, forever. The portfolio analogue of
 * buy-and-hold, and the benchmark any multi-asset strategy has to beat before
 * its complexity is worth anything.
 */
export const equalWeight: PortfolioStrategyFactory = {
  name: 'equal-weight',
  defaults: { invested: 1 },
  grid: {},
  create(series: AlignedSeries, params: Params): PortfolioStrategy {
    const invested = param(params, 'invested', 1);
    const weights = series.symbols.map(() => invested / series.symbols.length);
    return {
      name: 'equal-weight',
      params: { invested },
      warmup: 0,
      weightsAt: () => weights,
    };
  },
};
