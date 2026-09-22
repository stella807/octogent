import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, ema } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Long while the fast EMA is above the slow EMA, flat otherwise, with an ATR
 * stop underneath. Trend following: a low win rate paired with a high payoff
 * ratio, which is the opposite shape of what the "0% losses" pitch promises
 * and the reason it survives regime changes.
 */
export const emaCrossover: StrategyFactory = {
  name: 'ema-crossover',
  defaults: { fast: 20, slow: 60, atrPeriod: 14, atrStopMult: 3 },
  grid: {
    fast: [10, 20, 30],
    slow: [50, 80, 120],
    atrStopMult: [2, 3, 4],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const fast = param(params, 'fast', 20);
    const slow = param(params, 'slow', 60);
    const atrPeriod = param(params, 'atrPeriod', 14);
    const stopMult = param(params, 'atrStopMult', 3);
    if (fast >= slow) {
      throw new RangeError(`ema-crossover needs fast < slow, got ${fast} >= ${slow}`);
    }

    const price = closes(candles);
    const fastLine = ema(price, fast);
    const slowLine = ema(price, slow);
    const atrLine = atr(candles, atrPeriod);

    return {
      name: 'ema-crossover',
      params: { fast, slow, atrPeriod, atrStopMult: stopMult },
      warmup: slow + atrPeriod,
      signalAt(i: number, position: Position | null): Signal {
        const f = fastLine[i];
        const s = slowLine[i];
        const a = atrLine[i];
        if (f === null || f === undefined || s === null || s === undefined) return FLAT;
        if (f <= s) return { target: 0, reason: 'fast EMA below slow EMA' };

        const close = (candles[i] as Candle).close;
        const atrValue = a ?? 0;
        // Ratchet the stop upward only; a stop that can loosen is not a stop.
        const raw = close - stopMult * atrValue;
        const stopPrice = position ? Math.max(position.stopPrice ?? raw, raw) : raw;
        return { target: 1, stopPrice, reason: 'fast EMA above slow EMA' };
      },
    };
  },
};
