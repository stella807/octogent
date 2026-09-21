import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, rollingMax, rollingMin } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Enter when price closes at a new `entry`-bar high, exit at an `exit`-bar low
 * or the ATR stop, whichever is hit first. The asymmetric windows matter: a
 * shorter exit window gives back less of an open profit than it costs in
 * whipsaws, which is where most of this family's edge lives.
 */
export const donchianBreakout: StrategyFactory = {
  name: 'donchian-breakout',
  defaults: { entry: 55, exit: 20, atrPeriod: 14, atrStopMult: 2.5 },
  grid: {
    entry: [20, 40, 55, 80],
    exit: [10, 20, 30],
    atrStopMult: [2, 2.5, 3.5],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const entry = param(params, 'entry', 55);
    const exit = param(params, 'exit', 20);
    const atrPeriod = param(params, 'atrPeriod', 14);
    const stopMult = param(params, 'atrStopMult', 2.5);
    if (exit >= entry) {
      throw new RangeError(`donchian needs exit < entry, got ${exit} >= ${entry}`);
    }

    const price = closes(candles);
    // Shift by one bar: the breakout level must be the channel as it stood
    // BEFORE this bar, otherwise every bar trivially touches its own extreme.
    const entryHigh = rollingMax(price, entry);
    const exitLow = rollingMin(price, exit);
    const atrLine = atr(candles, atrPeriod);

    return {
      name: 'donchian-breakout',
      params: { entry, exit, atrPeriod, atrStopMult: stopMult },
      warmup: entry + atrPeriod + 1,
      signalAt(i: number, position: Position | null): Signal {
        if (i < 1) return FLAT;
        const priorHigh = entryHigh[i - 1];
        const priorLow = exitLow[i - 1];
        if (priorHigh === null || priorHigh === undefined) return FLAT;
        const close = (candles[i] as Candle).close;
        const atrValue = atrLine[i] ?? 0;

        if (position === null) {
          if (close <= priorHigh) return { target: 0, reason: 'no breakout' };
          return {
            target: 1,
            stopPrice: close - stopMult * atrValue,
            reason: `close ${close.toFixed(2)} broke ${entry}-bar high ${priorHigh.toFixed(2)}`,
          };
        }

        if (priorLow !== null && priorLow !== undefined && close < priorLow) {
          return { target: 0, reason: `close broke ${exit}-bar low` };
        }
        const raw = close - stopMult * atrValue;
        return {
          target: 1,
          stopPrice: Math.max(position.stopPrice ?? raw, raw),
          reason: 'holding breakout',
        };
      },
    };
  },
};
