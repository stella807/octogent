import type { Candle, Position, Signal } from '../domain/types.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * The high-win-rate trap, made runnable.
 *
 * This is how a "99% of trades are profitable" bot is actually built: take a
 * tiny profit almost immediately, and put the stop so far away it is rarely
 * touched. The win rate goes wherever you want it — tighten the target and
 * widen the stop and you can manufacture 99%, or 99.9%.
 *
 * It is included as a demonstration, not as a strategy to trade. Run it and
 * read the expectancy and profit factor rather than the win rate: the wins are
 * capped at `takeProfitPct` minus the round-trip cost, while each loss is
 * `stopPct`, so a single stop erases hundreds of wins. High win rate is a
 * choice about trade shape, not evidence of edge, and selling it as the latter
 * is the core of the reel-bot pitch.
 */
export const takeProfitScalp: StrategyFactory = {
  name: 'take-profit-scalp',
  defaults: { takeProfitPct: 0.5, stopPct: 50 },
  grid: {
    takeProfitPct: [0.25, 0.5, 1],
    stopPct: [25, 50, 75],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const takeProfitPct = param(params, 'takeProfitPct', 0.5);
    const stopPct = param(params, 'stopPct', 50);
    if (takeProfitPct <= 0 || stopPct < 0 || stopPct >= 100) {
      throw new RangeError(
        `take-profit-scalp needs takeProfitPct > 0 and 0 <= stopPct < 100, got ${takeProfitPct}/${stopPct}`,
      );
    }
    // stopPct = 0 means no stop at all: the losing position is simply held
    // until it comes back. That is how a bot reaches a literal 100% win rate,
    // and the drawdown column is where the loss it is hiding shows up.
    const useStop = stopPct > 0;

    return {
      name: 'take-profit-scalp',
      params: { takeProfitPct, stopPct },
      warmup: 1,
      signalAt(i: number, position: Position | null): Signal {
        const close = (candles[i] as Candle).close;
        if (position === null) {
          return {
            target: 1,
            ...(useStop ? { stopPrice: close * (1 - stopPct / 100) } : {}),
            reason: 'always in; this strategy never waits for a setup',
          };
        }
        const target = position.entryPrice * (1 + takeProfitPct / 100);
        if (close >= target) {
          return { target: 0, reason: `took +${takeProfitPct}%` };
        }
        // The stop stays fixed rather than trailing: trailing it would cut the
        // losers short, which is exactly the thing this shape refuses to do.
        return { target: 1, stopPrice: position.stopPrice, reason: 'waiting for the tiny target' };
      },
    };
  },
};
