import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { adx, atr, closes, ema, rsi } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Two TradingView community indicators, implemented to their real published
 * formulas rather than guessed at, and combined the way they are actually
 * meant to be used: B-Xtrender reads trend DIRECTION, ADX gates trend
 * STRENGTH, so a directional signal is only acted on while the market is
 * genuinely trending rather than chopping sideways.
 *
 * B-Xtrender (Neal / Puppytherapy): the short-term line is RSI applied to
 * the spread between two EMAs of price, the long-term line is RSI applied to
 * a single longer EMA, both re-centred by subtracting 50 so zero means
 * neutral. Long when both lines agree the trend is up.
 *
 * "Range Detector" in the source material is a generic name used by several
 * unrelated TradingView scripts with different formulas (Kalman-filter
 * slope, ATR channel width, ADX, pivot bands), and the specific one in the
 * screenshot this strategy was built from is not published anywhere
 * accessible. Rather than guess at someone's unpublished formula, this uses
 * Wilder's ADX -- the textbook method for the same underlying question
 * ("is this market trending or ranging") that predates every community
 * variant of it. That substitution is deliberate and stated here rather than
 * left implicit.
 */
export const bxtrenderAdx: StrategyFactory = {
  name: 'bxtrender-adx',
  defaults: {
    shortEma1: 5, shortEma2: 20, shortRsiPeriod: 15,
    longEmaPeriod: 20, longRsiPeriod: 15,
    adxPeriod: 14, adxThreshold: 20,
    atrPeriod: 14, atrStopMult: 2.5,
  },
  grid: {
    adxThreshold: [15, 20, 25, 30],
    shortRsiPeriod: [10, 15, 20],
    atrStopMult: [2, 2.5, 3],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const shortEma1 = param(params, 'shortEma1', 5);
    const shortEma2 = param(params, 'shortEma2', 20);
    const shortRsiPeriod = param(params, 'shortRsiPeriod', 15);
    const longEmaPeriod = param(params, 'longEmaPeriod', 20);
    const longRsiPeriod = param(params, 'longRsiPeriod', 15);
    const adxPeriod = param(params, 'adxPeriod', 14);
    const adxThreshold = param(params, 'adxThreshold', 20);
    const atrPeriod = param(params, 'atrPeriod', 14);
    const stopMult = param(params, 'atrStopMult', 2.5);
    if (shortEma1 >= shortEma2) {
      throw new RangeError(`bxtrender-adx needs shortEma1 < shortEma2, got ${shortEma1} >= ${shortEma2}`);
    }

    const price = closes(candles);
    const emaFast = ema(price, shortEma1);
    const emaSlow = ema(price, shortEma2);
    const emaSpread = price.map((_, i) => {
      const f = emaFast[i];
      const s = emaSlow[i];
      return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : NaN;
    });
    const shortLine = rsi(emaSpread.map((v) => (Number.isNaN(v) ? 0 : v)), shortRsiPeriod)
      .map((v, i) => (Number.isNaN(emaSpread[i] as number) || v === null ? null : v - 50));

    const longEma = ema(price, longEmaPeriod);
    const longLine = rsi(longEma.map((v) => v ?? 0), longRsiPeriod)
      .map((v, i) => (longEma[i] === null || longEma[i] === undefined || v === null ? null : v - 50));

    const { adx: adxLine } = adx(candles, adxPeriod);
    const atrLine = atr(candles, atrPeriod);

    const warmup = Math.max(
      shortEma2 + shortRsiPeriod,
      longEmaPeriod + longRsiPeriod,
      adxPeriod * 2,
      atrPeriod,
    ) + 2;

    return {
      name: 'bxtrender-adx',
      params: {
        shortEma1, shortEma2, shortRsiPeriod, longEmaPeriod, longRsiPeriod,
        adxPeriod, adxThreshold, atrPeriod, atrStopMult: stopMult,
      },
      warmup,
      signalAt(i: number, position: Position | null): Signal {
        const short = shortLine[i];
        const long = longLine[i];
        const strength = adxLine[i];
        if (short === null || short === undefined || long === null || long === undefined
          || strength === null || strength === undefined) {
          return FLAT;
        }
        const close = (candles[i] as Candle).close;
        const atrValue = atrLine[i] ?? 0;
        const trendingUp = short > 0 && long > 0;
        const strongEnough = strength >= adxThreshold;

        if (position === null) {
          if (!trendingUp || !strongEnough) {
            return {
              target: 0,
              reason: !strongEnough
                ? `ADX ${strength.toFixed(1)} < ${adxThreshold}: market is ranging, not trending`
                : 'B-Xtrender not aligned up on both timeframes',
            };
          }
          return {
            target: 1,
            stopPrice: close - stopMult * atrValue,
            reason: `B-Xtrender up (short ${short.toFixed(1)}, long ${long.toFixed(1)}), ADX ${strength.toFixed(1)} confirms trend`,
          };
        }

        // Exit on direction flip or the trend losing enough strength to call
        // it a trend at all -- either one means the premise for holding is gone.
        if (!trendingUp || strength < adxThreshold * 0.75) {
          return { target: 0, reason: !trendingUp ? 'B-Xtrender flipped down' : 'ADX faded, trend losing strength' };
        }
        const raw = close - stopMult * atrValue;
        return { target: 1, stopPrice: Math.max(position.stopPrice ?? raw, raw), reason: 'trend intact' };
      },
    };
  },
};
