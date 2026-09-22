import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, rollingMax, rollingMin } from '../indicators/index.ts';
import {
  param,
  type Params,
  type Strategy,
  type StrategyContext,
  type StrategyFactory,
} from './types.ts';

/**
 * `donchian-breakout`, with one addition: refuse a NEW entry when yesterday's
 * Fear & Greed reading was in "extreme greed" territory. The theory being
 * tested — a real one, not invented for this repo — is that a breakout
 * arriving during broad euphoria is more likely to be the blow-off top of a
 * move than the start of one, so gating entries there should cut off the
 * worst-timed trades without touching the ones that matter.
 *
 * Existing positions are managed exactly as `donchian-breakout` would: the
 * sentiment gate only ever blocks a new entry, never forces an exit. That is
 * deliberate — it isolates what the filter changes to entry timing alone, so
 * a walk-forward comparison against the ungated strategy attributes any
 * difference to the filter and nothing else.
 *
 * This is a hypothesis being tested with the same rigor as everything else in
 * this repo, not a strategy presumed to work because the signal sounds smart.
 * `docs/architecture.md` and the README report whether it actually helped.
 */
export const donchianSentiment: StrategyFactory = {
  name: 'donchian-sentiment',
  defaults: { entry: 55, exit: 20, atrPeriod: 14, atrStopMult: 2.5, greedThreshold: 80 },
  grid: {
    entry: [20, 40, 55, 80],
    exit: [10, 20, 30],
    greedThreshold: [70, 80, 90],
  },
  create(candles: readonly Candle[], params: Params, context?: StrategyContext): Strategy {
    const entry = param(params, 'entry', 55);
    const exit = param(params, 'exit', 20);
    const atrPeriod = param(params, 'atrPeriod', 14);
    const stopMult = param(params, 'atrStopMult', 2.5);
    const greedThreshold = param(params, 'greedThreshold', 80);
    if (exit >= entry) {
      throw new RangeError(`donchian-sentiment needs exit < entry, got ${exit} >= ${entry}`);
    }

    const price = closes(candles);
    const entryHigh = rollingMax(price, entry);
    const exitLow = rollingMin(price, exit);
    const atrLine = atr(candles, atrPeriod);
    const sentiment = context?.sentiment;

    return {
      name: 'donchian-sentiment',
      params: { entry, exit, atrPeriod, atrStopMult: stopMult, greedThreshold },
      // +1 beyond the plain strategy's warmup: bar 0 has no "prior day" to
      // read a sentiment value from, so the first usable bar starts one later.
      warmup: entry + atrPeriod + 2,
      signalAt(i: number, position: Position | null): Signal {
        if (i < 1) return FLAT;
        const priorHigh = entryHigh[i - 1];
        const priorLow = exitLow[i - 1];
        if (priorHigh === null || priorHigh === undefined) return FLAT;
        const close = (candles[i] as Candle).close;
        const atrValue = atrLine[i] ?? 0;

        if (position === null) {
          if (close <= priorHigh) return { target: 0, reason: 'no breakout' };
          const reading = sentiment?.[i] ?? null;
          if (reading !== null && reading >= greedThreshold) {
            return {
              target: 0,
              reason: `breakout at close ${close.toFixed(2)} skipped: sentiment ${reading} >= extreme-greed threshold ${greedThreshold}`,
            };
          }
          return {
            target: 1,
            stopPrice: close - stopMult * atrValue,
            reason: `close ${close.toFixed(2)} broke ${entry}-bar high ${priorHigh.toFixed(2)}, sentiment ${reading ?? 'unavailable'}`,
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
