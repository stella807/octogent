import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Time-series momentum, in the specific form the academic literature tests it:
 * long when the trailing N-bar return is positive, flat otherwise. Nothing
 * more. No crossover, no channel — just the sign of "where is price now versus
 * `lookback` bars ago".
 *
 * This is deliberately the plainest possible trend rule, because that is what
 * the research actually studied. Moskowitz, Ooi & Pedersen (2012) found it
 * across 58 futures markets; in crypto specifically, evidence is strong at
 * daily/weekly frequency but the effect concentrates in volatile, regime-
 * changing periods and mostly evaporates once realistic costs are charged —
 * several studies report momentum portfolios "liquidated" by transaction costs
 * once assessed rigorously. `ema-crossover` and `donchian-breakout` already
 * cover more elaborate trend rules; this one exists so the walk-forward report
 * can show whether the simplest version of the idea holds up at all, since a
 * strategy that needs elaboration to work is a strategy that is being tuned
 * toward the past.
 */
export const tsmom: StrategyFactory = {
  name: 'tsmom',
  defaults: { lookback: 90, atrPeriod: 14, atrStopMult: 3 },
  grid: {
    lookback: [20, 30, 60, 90, 180, 252],
    atrStopMult: [2, 3, 4],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const lookback = param(params, 'lookback', 90);
    const atrPeriod = param(params, 'atrPeriod', 14);
    const stopMult = param(params, 'atrStopMult', 3);
    if (lookback < 2) throw new RangeError(`tsmom needs lookback >= 2, got ${lookback}`);

    const price = closes(candles);
    const atrLine = atr(candles, atrPeriod);

    return {
      name: 'tsmom',
      params: { lookback, atrPeriod, atrStopMult: stopMult },
      warmup: lookback + atrPeriod,
      signalAt(i: number, position: Position | null): Signal {
        const past = price[i - lookback];
        if (past === undefined || past <= 0) return FLAT;
        const close = (candles[i] as Candle).close;
        const trailingReturn = close / past - 1;

        if (trailingReturn <= 0) {
          return { target: 0, reason: `${lookback}-bar return ${(trailingReturn * 100).toFixed(1)}% <= 0` };
        }
        const atrValue = atrLine[i] ?? 0;
        const raw = close - stopMult * atrValue;
        const stopPrice = position ? Math.max(position.stopPrice ?? raw, raw) : raw;
        return {
          target: 1,
          stopPrice,
          reason: `${lookback}-bar return ${(trailingReturn * 100).toFixed(1)}% > 0`,
        };
      },
    };
  },
};
