import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, sma, stdev } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Z-score mean reversion against a rolling mean and standard deviation (the
 * mechanism a Bollinger Band actually is), rather than `rsi-mean-reversion`'s
 * RSI threshold. Same family, different instrument: RSI measures the ratio of
 * average gains to losses, this measures how many standard deviations price
 * sits from its own recent mean. They agree often and disagree at the edges,
 * which is exactly where it matters — an industry backtest (Kaiko, 2025) on
 * 150 altcoins reported price reverting toward the mean 81% of the time within
 * five days once the Z-score passed +/-2.5, which is the entry threshold used
 * here by default. That is a vendor blog claim, not a peer-reviewed result,
 * and it is exactly the kind of number that dissolves under walk-forward once
 * costs and a genuine trend are in the sample — which is what this repo's
 * validation tools exist to check rather than assume.
 *
 * Same trend filter as `rsi-mean-reversion`, for the same reason: mean
 * reversion with no trend filter dies the first time the "oversold" reading is
 * actually the start of a real decline rather than a dip.
 */
export const bollingerReversion: StrategyFactory = {
  name: 'bollinger-reversion',
  defaults: { period: 20, entryZ: 2.5, exitZ: 0.5, trendPeriod: 200, atrStopMult: 3 },
  grid: {
    period: [14, 20, 30],
    entryZ: [2, 2.5, 3],
    trendPeriod: [100, 200],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const period = param(params, 'period', 20);
    const entryZ = param(params, 'entryZ', 2.5);
    const exitZ = param(params, 'exitZ', 0.5);
    const trendPeriod = param(params, 'trendPeriod', 200);
    const stopMult = param(params, 'atrStopMult', 3);
    if (entryZ <= exitZ) {
      throw new RangeError(`bollinger-reversion needs entryZ > exitZ, got ${entryZ} <= ${exitZ}`);
    }

    const price = closes(candles);
    const mean = sma(price, period);
    const sd = stdev(price, period);
    const trendLine = sma(price, trendPeriod);
    const atrLine = atr(candles, 14);

    return {
      name: 'bollinger-reversion',
      params: { period, entryZ, exitZ, trendPeriod, atrStopMult: stopMult },
      warmup: Math.max(period, trendPeriod) + 1,
      signalAt(i: number, position: Position | null): Signal {
        const m = mean[i];
        const s = sd[i];
        const trend = trendLine[i];
        if (m === null || m === undefined || s === null || s === undefined
          || trend === null || trend === undefined || s <= 0) {
          return FLAT;
        }
        const close = (candles[i] as Candle).close;
        const z = (close - m) / s;
        const atrValue = atrLine[i] ?? 0;

        if (position === null) {
          if (close < trend) return { target: 0, reason: 'below trend filter' };
          if (z > -entryZ) return { target: 0, reason: `z=${z.toFixed(2)} not oversold` };
          return {
            target: 1,
            stopPrice: close - stopMult * atrValue,
            reason: `z=${z.toFixed(2)} <= -${entryZ}, buying the dip`,
          };
        }

        if (z >= -exitZ) return { target: 0, reason: `z=${z.toFixed(2)} reverted toward mean` };
        return { target: 1, stopPrice: position.stopPrice, reason: 'waiting for reversion' };
      },
    };
  },
};
