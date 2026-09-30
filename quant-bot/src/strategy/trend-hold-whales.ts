import type { Candle, Position, Signal } from '../domain/types.ts';
import { closes, sma } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyContext, type StrategyFactory } from './types.ts';

/**
 * `trend-hold`, plus one rule from on-chain data: no NEW entry while whales
 * have been net sending the coin to exchanges over the last `flowDays` days
 * (Arkham exchange netflow, lagged a day). Coins moving onto exchanges are
 * usually about to be sold; buying into that is buying from the whales.
 *
 * Like `donchian-sentiment`, the filter only gates entries and never forces
 * an exit, so a comparison against plain trend-hold attributes any difference
 * to the filter alone. With no whale data (null), it is exactly trend-hold.
 */
export const trendHoldWhales: StrategyFactory = {
  name: 'trend-hold-whales',
  defaults: { period: 200, bandPct: 2, flowDays: 7 },
  grid: {
    period: [100, 150, 200],
    bandPct: [0, 2, 5],
    flowDays: [3, 7, 14],
  },
  create(candles: readonly Candle[], params: Params, context?: StrategyContext): Strategy {
    const period = param(params, 'period', 200);
    const bandPct = param(params, 'bandPct', 2);
    const flowDays = param(params, 'flowDays', 7);
    if (period < 2) throw new RangeError(`trend-hold-whales needs period >= 2, got ${period}`);
    if (flowDays < 1) throw new RangeError(`trend-hold-whales needs flowDays >= 1, got ${flowDays}`);
    const average = sma(closes(candles), period);
    const band = bandPct / 100;
    const flow = context?.whaleNetflow;

    /** Net USD whales sent to exchanges over the window, or null if none of it is known. */
    const recentNetflow = (i: number): number | null => {
      if (!flow) return null;
      let sum = 0;
      let known = 0;
      for (let j = Math.max(0, i - flowDays + 1); j <= i; j += 1) {
        const v = flow[j];
        if (v === null || v === undefined) continue;
        sum += v;
        known += 1;
      }
      return known > 0 ? sum : null;
    };

    return {
      name: 'trend-hold-whales',
      params: { period, bandPct, flowDays },
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
        if (!(close > ma * (1 + band))) return { target: 0, reason: `no uptrend: ${vs}` };
        const netflow = recentNetflow(i);
        if (netflow !== null && netflow > 0) {
          return { target: 0, reason: `uptrend, but whales sent $${(netflow / 1e6).toFixed(1)}M net to exchanges in ${flowDays} days` };
        }
        return { target: 1, reason: `uptrend: ${vs}${netflow === null ? '' : `; whales took $${(-netflow / 1e6).toFixed(1)}M off exchanges`}` };
      },
    };
  },
};
