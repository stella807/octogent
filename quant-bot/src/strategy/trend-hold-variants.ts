import type { Candle, Position, Signal } from '../domain/types.ts';
import { atr, closes, sma } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Three candidate improvements to `trend-hold`, each changing one thing so a
 * comparison against trend-hold attributes any difference to that change.
 * None sets a stop price: a tight stop would make the 1%-risk sizing shrink
 * the position to a sliver, which is the very thing trend-hold exists to
 * avoid. Early exits are ordinary signals instead.
 */

interface Base {
  readonly period: number;
  readonly band: number;
  readonly average: readonly (number | null)[];
}

function base(candles: readonly Candle[], period: number, bandPct: number): Base {
  if (period < 2) throw new RangeError(`period must be >= 2, got ${period}`);
  if (bandPct < 0) throw new RangeError(`bandPct must be >= 0, got ${bandPct}`);
  return { period, band: bandPct / 100, average: sma(closes(candles), period) };
}

/** trend-hold's own exit: a close below the average by the band. */
function trendBroken(close: number, ma: number, band: number): boolean {
  return close < ma * (1 - band);
}

/** Enter only when the fast average is also above the slow one: a stronger trend than price alone. */
export const trendHoldDual: StrategyFactory = {
  name: 'trend-hold-dual',
  defaults: { period: 200, bandPct: 2, fast: 50 },
  grid: { period: [150, 200], bandPct: [0, 2, 5], fast: [30, 50, 100] },
  create(candles: readonly Candle[], params: Params): Strategy {
    const period = param(params, 'period', 200);
    const bandPct = param(params, 'bandPct', 2);
    const fast = param(params, 'fast', 50);
    if (fast >= period) throw new RangeError(`trend-hold-dual needs fast < period, got ${fast} >= ${period}`);
    const { band, average } = base(candles, period, bandPct);
    const fastAvg = sma(closes(candles), fast);
    return {
      name: 'trend-hold-dual',
      params: { period, bandPct, fast },
      warmup: period,
      signalAt(i: number, position: Position | null): Signal {
        const ma = average[i];
        const fa = fastAvg[i];
        if (ma == null || fa == null || !(ma > 0)) return { target: 0 };
        const close = (candles[i] as Candle).close;
        if (position !== null) {
          return trendBroken(close, ma, band)
            ? { target: 0, reason: 'trend broken' }
            : { target: 1, reason: 'trend intact' };
        }
        return close > ma * (1 + band) && fa > ma
          ? { target: 1, reason: `uptrend and ${fast}-bar average above ${period}-bar` }
          : { target: 0, reason: 'no confirmed uptrend' };
      },
    };
  },
};

/** Also exit when price falls `atrMult` typical daily ranges below its high since entry: a smaller worst drop. */
export const trendHoldTrail: StrategyFactory = {
  name: 'trend-hold-trail',
  defaults: { period: 200, bandPct: 2, atrPeriod: 14, atrMult: 3 },
  grid: { period: [150, 200], bandPct: [0, 2, 5], atrMult: [3, 4, 6] },
  create(candles: readonly Candle[], params: Params): Strategy {
    const period = param(params, 'period', 200);
    const bandPct = param(params, 'bandPct', 2);
    const atrPeriod = param(params, 'atrPeriod', 14);
    const atrMult = param(params, 'atrMult', 3);
    if (atrMult <= 0) throw new RangeError(`trend-hold-trail needs atrMult > 0, got ${atrMult}`);
    const { band, average } = base(candles, period, bandPct);
    const atrLine = atr(candles, atrPeriod);
    return {
      name: 'trend-hold-trail',
      params: { period, bandPct, atrPeriod, atrMult },
      warmup: period,
      signalAt(i: number, position: Position | null): Signal {
        const ma = average[i];
        if (ma == null || !(ma > 0)) return { target: 0 };
        const close = (candles[i] as Candle).close;
        if (position !== null) {
          if (trendBroken(close, ma, band)) return { target: 0, reason: 'trend broken' };
          const range = atrLine[i];
          if (range != null && close < position.highWaterPrice - atrMult * range) {
            return { target: 0, reason: `fell ${atrMult} ranges from its high` };
          }
          return { target: 1, reason: 'trend intact' };
        }
        return close > ma * (1 + band) ? { target: 1, reason: 'uptrend' } : { target: 0, reason: 'no uptrend' };
      },
    };
  },
};

/** Enter only when the slow average itself is rising: skips entries into a flat or falling long-term trend. */
export const trendHoldSlope: StrategyFactory = {
  name: 'trend-hold-slope',
  defaults: { period: 200, bandPct: 2, slopeBars: 20 },
  grid: { period: [150, 200], bandPct: [0, 2, 5], slopeBars: [10, 20, 40] },
  create(candles: readonly Candle[], params: Params): Strategy {
    const period = param(params, 'period', 200);
    const bandPct = param(params, 'bandPct', 2);
    const slopeBars = param(params, 'slopeBars', 20);
    if (slopeBars < 1) throw new RangeError(`trend-hold-slope needs slopeBars >= 1, got ${slopeBars}`);
    const { band, average } = base(candles, period, bandPct);
    return {
      name: 'trend-hold-slope',
      params: { period, bandPct, slopeBars },
      warmup: period + slopeBars,
      signalAt(i: number, position: Position | null): Signal {
        const ma = average[i];
        const before = average[i - slopeBars];
        if (ma == null || before == null || !(ma > 0)) return { target: 0 };
        const close = (candles[i] as Candle).close;
        if (position !== null) {
          return trendBroken(close, ma, band)
            ? { target: 0, reason: 'trend broken' }
            : { target: 1, reason: 'trend intact' };
        }
        return close > ma * (1 + band) && ma > before
          ? { target: 1, reason: `uptrend, ${period}-bar average rising` }
          : { target: 0, reason: 'no uptrend, or average not rising' };
      },
    };
  },
};
