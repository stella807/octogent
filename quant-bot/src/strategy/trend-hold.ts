import type { Candle, Position, Signal } from '../domain/types.ts';
import { closes, sma } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Hold the whole position while price is above its long moving average; sit
 * in cash while it is below. The oldest trend filter there is (Faber 2007,
 * the 10-month / 200-day rule), and the point of adding it is sizing rather
 * than signal: every other trend rule here carries a tight ATR stop, so the
 * 1%-risk sizing turns each entry into a few percent of the account and the
 * strategy spends ~95% of its life in cash. This one has no tight stop, so
 * the position limit sizes it and it actually holds the asset through a trend.
 *
 * The cost is honest drawdown: exiting on a close below the average means a
 * crash is only noticed after it has started. The band adds hysteresis so a
 * price chopping around the average does not trade on every crossing, since
 * each round trip costs two fees.
 */
export const trendHold: StrategyFactory = {
  name: 'trend-hold',
  defaults: { period: 200, bandPct: 2 },
  grid: {
    period: [50, 100, 150, 200],
    bandPct: [0, 2, 5],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const period = param(params, 'period', 200);
    const bandPct = param(params, 'bandPct', 2);
    if (period < 2) throw new RangeError(`trend-hold needs period >= 2, got ${period}`);
    if (bandPct < 0) throw new RangeError(`trend-hold needs bandPct >= 0, got ${bandPct}`);
    const average = sma(closes(candles), period);
    const band = bandPct / 100;

    return {
      name: 'trend-hold',
      params: { period, bandPct },
      warmup: period,
      signalAt(i: number, position: Position | null): Signal {
        const ma = average[i];
        if (ma === undefined || ma === null || !(ma > 0)) return { target: 0 };
        const close = (candles[i] as Candle).close;
        const vs = `${((close / ma - 1) * 100).toFixed(1)}% vs ${period}-bar average`;
        if (position !== null) {
          return close < ma * (1 - band)
            ? { target: 0, reason: `trend broken: ${vs}` }
            : { target: 1, reason: `trend intact: ${vs}` };
        }
        return close > ma * (1 + band)
          ? { target: 1, reason: `uptrend: ${vs}` }
          : { target: 0, reason: `no uptrend: ${vs}` };
      },
    };
  },
};
