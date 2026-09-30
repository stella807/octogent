import type { Candle, Position, Signal } from '../domain/types.ts';
import { closes, sma } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Hold the whole position while at least `minVotes` of three trend tests
 * agree: price above its 50-, 100- and 200-bar averages. A single-average
 * rule flips on one noisy close near its line and waits for the slowest
 * average to turn; a vote reacts as soon as most horizons agree and lets one
 * dissenting horizon (a dip under the 50) pass without selling.
 *
 * Entry needs `minVotes` tests above their average by the band; exit needs the
 * count of tests still above (average minus the band) to fall below
 * `minVotes`. The asymmetric band is hysteresis, so a price hovering around
 * a line does not trade on every crossing at 0.6% a side.
 *
 * All in or all out, no stop price. The live runner only enters or exits, so
 * a partial-exposure rule would trade differently live than it did in the
 * backtest.
 */
export const trendVote: StrategyFactory = {
  name: 'trend-vote',
  defaults: { fast: 50, mid: 100, slow: 200, bandPct: 2, minVotes: 2 },
  grid: {
    bandPct: [0, 2, 5],
    minVotes: [2, 3],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const fast = param(params, 'fast', 50);
    const mid = param(params, 'mid', 100);
    const slow = param(params, 'slow', 200);
    const bandPct = param(params, 'bandPct', 2);
    const minVotes = param(params, 'minVotes', 2);
    if (!(fast < mid && mid < slow)) throw new RangeError(`trend-vote needs fast < mid < slow, got ${fast}, ${mid}, ${slow}`);
    if (bandPct < 0) throw new RangeError(`trend-vote needs bandPct >= 0, got ${bandPct}`);
    if (![1, 2, 3].includes(minVotes)) throw new RangeError(`trend-vote needs minVotes of 1, 2 or 3, got ${minVotes}`);
    const price = closes(candles);
    const averages = [sma(price, fast), sma(price, mid), sma(price, slow)];
    const band = bandPct / 100;

    /** How many of the three tests price passes, with `edge` applied to each average. */
    const votes = (i: number, edge: number): number | null => {
      const close = (candles[i] as Candle).close;
      let n = 0;
      for (const avg of averages) {
        const ma = avg[i];
        if (ma === undefined || ma === null || !(ma > 0)) return null;
        if (close > ma * edge) n += 1;
      }
      return n;
    };

    return {
      name: 'trend-vote',
      params: { fast, mid, slow, bandPct, minVotes },
      warmup: slow,
      signalAt(i: number, position: Position | null): Signal {
        if (position !== null) {
          const holding = votes(i, 1 - band);
          if (holding === null) return { target: 0 };
          return holding >= minVotes
            ? { target: 1, reason: `${holding} of 3 trend tests still hold` }
            : { target: 0, reason: `only ${holding} of 3 trend tests hold` };
        }
        const entering = votes(i, 1 + band);
        if (entering === null) return { target: 0 };
        return entering >= minVotes
          ? { target: 1, reason: `${entering} of 3 trend tests up` }
          : { target: 0, reason: `only ${entering} of 3 trend tests up` };
      },
    };
  },
};
