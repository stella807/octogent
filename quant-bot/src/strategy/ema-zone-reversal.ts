import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, ema } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * From a TradingView listing ("PlayBit EMA"): two EMAs plotted as a shaded
 * channel, used to read support/resistance and reversal points rather than
 * as a simple crossover. This is a genuinely different mechanism from
 * `ema-crossover` in this repo, which trades the crossover itself; this one
 * treats the zone BETWEEN the two EMAs as dynamic support in an uptrend and
 * buys the bounce off it, which is a real, long-established technique
 * (trading pullbacks to a moving average) distinct enough to be worth
 * testing on its own rather than assumed identical to the crossover version.
 *
 * Long-only, matching this repo's spot-only design: price must be in an
 * established uptrend (both EMAs rising, fast above slow) for a pullback
 * into the zone to be read as support rather than the start of a breakdown.
 * Entry is the bounce -- price re-closing above the fast EMA after having
 * touched the zone -- not the touch itself, since buying the exact low of a
 * pullback with no confirmation is how "support" becomes "falling knife."
 */
export const emaZoneReversal: StrategyFactory = {
  name: 'ema-zone-reversal',
  defaults: { fastPeriod: 20, slowPeriod: 50, atrPeriod: 14, atrStopMult: 2 },
  grid: {
    fastPeriod: [10, 20, 30],
    slowPeriod: [40, 50, 80],
    atrStopMult: [1.5, 2, 2.5],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const fastPeriod = param(params, 'fastPeriod', 20);
    const slowPeriod = param(params, 'slowPeriod', 50);
    const atrPeriod = param(params, 'atrPeriod', 14);
    const stopMult = param(params, 'atrStopMult', 2);
    if (fastPeriod >= slowPeriod) {
      throw new RangeError(`ema-zone-reversal needs fastPeriod < slowPeriod, got ${fastPeriod} >= ${slowPeriod}`);
    }

    const price = closes(candles);
    const fastLine = ema(price, fastPeriod);
    const slowLine = ema(price, slowPeriod);
    const atrLine = atr(candles, atrPeriod);
    const warmup = slowPeriod + atrPeriod + 2;

    return {
      name: 'ema-zone-reversal',
      params: { fastPeriod, slowPeriod, atrPeriod, atrStopMult: stopMult },
      warmup,
      signalAt(i: number, position: Position | null): Signal {
        const fast = fastLine[i];
        const slow = slowLine[i];
        const fastPrev = fastLine[i - 1];
        if (fast === null || fast === undefined || slow === null || slow === undefined
          || fastPrev === null || fastPrev === undefined) {
          return FLAT;
        }
        const close = (candles[i] as Candle).close;
        const prevClose = (candles[i - 1] as Candle).close;
        const atrValue = atrLine[i] ?? 0;
        const uptrend = fast > slow && fast > fastPrev;
        const zoneLow = Math.min(fast, slow);
        const zoneHigh = Math.max(fast, slow);

        if (position === null) {
          if (!uptrend) return { target: 0, reason: 'no established uptrend' };
          // The bounce: previous close was inside or below the zone, this
          // close is back above the fast EMA -- support held, not just touched.
          const touchedZone = prevClose <= zoneHigh;
          const bounced = close > fast;
          if (!touchedZone || !bounced) {
            return { target: 0, reason: 'no pullback-and-bounce off the EMA zone' };
          }
          return {
            target: 1,
            stopPrice: zoneLow - stopMult * atrValue,
            reason: `bounced off EMA zone [${zoneLow.toFixed(2)}, ${zoneHigh.toFixed(2)}] in an uptrend`,
          };
        }

        // Exit if the zone itself breaks down (the "support" failed) or the
        // trend that made the zone a buy in the first place is gone.
        if (!uptrend || close < zoneLow) {
          return { target: 0, reason: !uptrend ? 'uptrend lost' : 'closed below the EMA zone: support failed' };
        }
        const raw = zoneLow - stopMult * atrValue;
        return { target: 1, stopPrice: Math.max(position.stopPrice ?? raw, raw), reason: 'holding above the zone' };
      },
    };
  },
};
