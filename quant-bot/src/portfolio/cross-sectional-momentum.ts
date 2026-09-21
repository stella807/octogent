import type { Candle } from '../domain/types.ts';
import { param, type Params } from '../strategy/types.ts';
import type { AlignedSeries } from './align.ts';
import type { PortfolioStrategy, PortfolioStrategyFactory } from './types.ts';

/**
 * Dual momentum: hold the strongest few symbols, but only while they are also
 * rising on their own terms.
 *
 * The cross-sectional half (rank the universe, keep the leaders) is what earns
 * the return. The absolute half (require a positive own return) is what keeps
 * the portfolio out of a market where *everything* is falling — without it,
 * "the best of ten coins in a crash" is still a coin in a crash, and the
 * strategy rides the whole drawdown holding whatever fell least.
 *
 * Weights are fixed at 1/topK rather than 1/qualifiers, so when only two of ten
 * symbols pass the filter the portfolio holds two positions and the rest in
 * cash, instead of concentrating the whole account into the two survivors at
 * the exact moment breadth is collapsing.
 */
export const crossSectionalMomentum: PortfolioStrategyFactory = {
  name: 'cross-sectional-momentum',
  defaults: { lookback: 90, topK: 3, rebalanceEvery: 7, absoluteFilter: 1 },
  grid: {
    lookback: [30, 60, 90, 180],
    topK: [2, 3, 5],
    rebalanceEvery: [7, 14, 30],
  },
  create(series: AlignedSeries, params: Params): PortfolioStrategy {
    const lookback = param(params, 'lookback', 90);
    const topK = Math.max(1, Math.trunc(param(params, 'topK', 3)));
    const rebalanceEvery = Math.max(1, Math.trunc(param(params, 'rebalanceEvery', 7)));
    const absoluteFilter = param(params, 'absoluteFilter', 1) > 0;
    if (lookback < 2) throw new RangeError(`lookback must be >= 2, got ${lookback}`);

    const count = series.symbols.length;
    const closes = series.bars.map((bars) => bars.map((b: Candle) => b.close));

    const momentumAt = (s: number, bar: number): number | null => {
      const past = (closes[s] as number[])[bar - lookback];
      const now = (closes[s] as number[])[bar];
      if (past === undefined || now === undefined || past <= 0) return null;
      return now / past - 1;
    };

    return {
      name: 'cross-sectional-momentum',
      params: { lookback, topK, rebalanceEvery, absoluteFilter: absoluteFilter ? 1 : 0 },
      warmup: lookback + rebalanceEvery,
      weightsAt(i: number): readonly number[] {
        // Weights are computed from the most recent scheduled rebalance bar, so
        // asking on any bar returns what the portfolio should currently hold —
        // deterministic, and never dependent on call order or hidden state.
        const anchor = i - (i % rebalanceEvery);
        const weights = new Array<number>(count).fill(0);
        if (anchor < lookback) return weights;

        const ranked: { symbol: number; momentum: number }[] = [];
        for (let s = 0; s < count; s += 1) {
          const momentum = momentumAt(s, anchor);
          if (momentum === null) continue;
          if (absoluteFilter && momentum <= 0) continue;
          ranked.push({ symbol: s, momentum });
        }
        ranked.sort((a, b) => b.momentum - a.momentum);

        for (const { symbol } of ranked.slice(0, topK)) {
          weights[symbol] = 1 / topK;
        }
        return weights;
      },
    };
  },
};
