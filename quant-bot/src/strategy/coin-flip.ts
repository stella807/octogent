import type { Candle, Signal } from '../domain/types.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Long or flat at random, redrawn every bar. It exists as a control: run
 * enough strategies side by side and some will be up by luck, and this is
 * what luck alone scores under the same fees. A strategy that cannot beat it
 * has shown nothing.
 *
 * The draw hashes the bar's own timestamp rather than advancing a random
 * stream, so the decision for a bar never depends on how much history came
 * before it: a backtest and a live run on a sliding window make the same call.
 */
export const coinFlipStrategy: StrategyFactory = {
  name: 'coin-flip',
  defaults: { seed: 1 },
  grid: {},
  create(candles: readonly Candle[], params: Params): Strategy {
    const seed = param(params, 'seed', 1);
    return {
      name: 'coin-flip',
      params: { seed },
      warmup: 0,
      signalAt(i: number): Signal {
        const bar = candles[i];
        if (!bar) return { target: 0 };
        const heads = unitHash(bar.time, seed) < 0.5;
        return { target: heads ? 1 : 0, reason: heads ? 'coin flip: heads, long' : 'coin flip: tails, flat' };
      },
    };
  },
};

/** SplitMix64-style mix of (time, seed) to [0, 1). Math.imul keeps it in 32-bit integer arithmetic. */
function unitHash(time: number, seed: number): number {
  let h = (Math.floor(time / 1000) ^ Math.imul(seed | 0, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
