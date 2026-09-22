import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, rsi, sma } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Buy oversold dips, but only while price is above its long trend filter.
 *
 * Mean reversion without a trend filter is how accounts die: it produces a
 * gorgeous equity curve with a 90% win rate right up until the one downtrend
 * where it averages into a collapse. The filter and the ATR stop are what turn
 * a high win rate into a survivable one, and the backtest report deliberately
 * prints max drawdown next to win rate so the tradeoff stays visible.
 */
export const rsiMeanReversion: StrategyFactory = {
  name: 'rsi-mean-reversion',
  defaults: { rsiPeriod: 14, entryLevel: 30, exitLevel: 55, trendPeriod: 200, atrStopMult: 3 },
  grid: {
    entryLevel: [20, 25, 30],
    exitLevel: [50, 55, 65],
    trendPeriod: [100, 200],
    atrStopMult: [2, 3],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const rsiPeriod = param(params, 'rsiPeriod', 14);
    const entryLevel = param(params, 'entryLevel', 30);
    const exitLevel = param(params, 'exitLevel', 55);
    const trendPeriod = param(params, 'trendPeriod', 200);
    const stopMult = param(params, 'atrStopMult', 3);
    if (entryLevel >= exitLevel) {
      throw new RangeError(`rsi needs entryLevel < exitLevel, got ${entryLevel} >= ${exitLevel}`);
    }

    const price = closes(candles);
    const rsiLine = rsi(price, rsiPeriod);
    const trendLine = sma(price, trendPeriod);
    const atrLine = atr(candles, 14);

    return {
      name: 'rsi-mean-reversion',
      params: { rsiPeriod, entryLevel, exitLevel, trendPeriod, atrStopMult: stopMult },
      warmup: trendPeriod + rsiPeriod,
      signalAt(i: number, position: Position | null): Signal {
        const r = rsiLine[i];
        const trend = trendLine[i];
        if (r === null || r === undefined || trend === null || trend === undefined) return FLAT;
        const close = (candles[i] as Candle).close;
        const atrValue = atrLine[i] ?? 0;

        if (position === null) {
          if (close < trend) return { target: 0, reason: 'below trend filter' };
          if (r > entryLevel) return { target: 0, reason: `RSI ${r.toFixed(1)} not oversold` };
          return {
            target: 1,
            stopPrice: close - stopMult * atrValue,
            reason: `RSI ${r.toFixed(1)} oversold in uptrend`,
          };
        }

        if (r >= exitLevel) return { target: 0, reason: `RSI ${r.toFixed(1)} reverted` };
        return { target: 1, stopPrice: position.stopPrice, reason: 'waiting for reversion' };
      },
    };
  },
};
