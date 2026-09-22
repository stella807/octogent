import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { barsPerYear, closes, logReturns, sma, stdev } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Volatility targeting: hold less when the market is wild, more when it is calm,
 * so the portfolio's risk stays roughly constant instead of tracking whatever
 * the asset happens to be doing.
 *
 * This is the one idea in this repo that institutions actually run, and it is
 * the opposite of how retail bots are built. A fixed position size means your
 * risk triples when volatility triples — which is exactly when you can least
 * afford it, because volatility spikes and drawdowns arrive together. Sizing
 * inversely to realised volatility is what keeps a crypto strategy's drawdown
 * in the range a person can actually sit through.
 *
 * There is no stop here on purpose: the exposure scaling IS the risk control,
 * and the drawdown kill switch is the backstop. Adding a stop on top would
 * double-count the same risk and shrink the position to nothing.
 */
export const volTarget: StrategyFactory = {
  name: 'vol-target',
  defaults: { targetVolPct: 20, volPeriod: 30, trendPeriod: 100, maxExposure: 1 },
  grid: {
    targetVolPct: [10, 20, 30],
    volPeriod: [20, 30, 60],
    trendPeriod: [50, 100, 200],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const targetVolPct = param(params, 'targetVolPct', 20);
    const volPeriod = param(params, 'volPeriod', 30);
    const trendPeriod = param(params, 'trendPeriod', 100);
    const maxExposure = param(params, 'maxExposure', 1);
    if (targetVolPct <= 0) {
      throw new RangeError(`vol-target needs targetVolPct > 0, got ${targetVolPct}`);
    }
    if (maxExposure <= 0 || maxExposure > 1) {
      throw new RangeError(
        `vol-target needs 0 < maxExposure <= 1 (spot, no leverage), got ${maxExposure}`,
      );
    }

    const price = closes(candles);
    const volLine = stdev(logReturns(price), volPeriod);
    const trendLine = sma(price, trendPeriod);
    const annualiser = Math.sqrt(barsPerYear(candles));
    const targetVol = targetVolPct / 100;

    return {
      name: 'vol-target',
      params: { targetVolPct, volPeriod, trendPeriod, maxExposure },
      warmup: Math.max(volPeriod, trendPeriod) + 1,
      signalAt(i: number, _position: Position | null): Signal {
        const barVol = volLine[i];
        const trend = trendLine[i];
        if (barVol === null || barVol === undefined || trend === null || trend === undefined) {
          return FLAT;
        }
        const close = (candles[i] as Candle).close;
        if (close < trend) {
          return { target: 0, reason: 'below trend filter' };
        }

        const realisedVol = barVol * annualiser;
        if (realisedVol <= 0) {
          // Zero measured volatility is a data artefact (a flat or stale
          // window), not a risk-free asset. Sizing off it would divide by ~0.
          return { target: 0, reason: 'no measurable volatility; refusing to size' };
        }
        const raw = targetVol / realisedVol;
        const target = Math.min(raw, maxExposure);
        return {
          target,
          reason: `realised vol ${(realisedVol * 100).toFixed(0)}% -> ${(target * 100).toFixed(0)}% exposure`,
        };
      },
    };
  },
};
