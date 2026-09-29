import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, sma } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * A long-only range grid, the most common "set and forget" bot strategy.
 *
 * When price falls a whole step below its moving average, the grid anchors a
 * fixed range there and buys one slice per step down, up to `levels` slices.
 * Each slice is sold once price recovers a full step above where it was
 * bought, so every round trip captures one step minus costs.
 *
 * The part grid marketing leaves out: the grid is most fully loaded exactly
 * when price is falling hardest, so a range that breaks downward turns a
 * string of small wins into one large loss. `stopLevels` below the bottom
 * slice is where this implementation admits the range has broken, exits
 * everything, and refuses to re-arm until price is back above its average.
 */
export const gridRange: StrategyFactory = {
  name: 'grid-range',
  defaults: { period: 50, stepAtr: 1, levels: 5, stopLevels: 2 },
  grid: {
    period: [20, 50],
    stepAtr: [0.5, 1, 2],
    levels: [3, 5],
    stopLevels: [1, 3],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const period = param(params, 'period', 50);
    const stepAtr = param(params, 'stepAtr', 1);
    const levels = param(params, 'levels', 5);
    const stopLevels = param(params, 'stopLevels', 2);
    if (!Number.isInteger(levels) || levels < 1 || levels > 10) {
      // Above 10 levels each slice is under the engine's 10% rebalance
      // threshold, so the grid would silently stop trading individual slices.
      throw new RangeError(`grid-range needs 1 <= levels <= 10 (integer), got ${levels}`);
    }
    if (stepAtr <= 0 || stopLevels <= 0) {
      throw new RangeError('grid-range needs stepAtr > 0 and stopLevels > 0');
    }

    const center = sma(closes(candles), period);
    const atrLine = atr(candles, 14);
    const path = gridPath(candles, center, atrLine, { stepAtr, levels, stopLevels });

    return {
      name: 'grid-range',
      params: { period, stepAtr, levels, stopLevels },
      warmup: Math.max(period, 15),
      signalAt(i: number, _position: Position | null): Signal {
        const state = path[i];
        if (!state) return FLAT;
        if (state.held === 0) return { target: 0, reason: state.reason };
        return {
          target: state.held / levels,
          stopPrice: state.bottom,
          reason: state.reason,
        };
      },
    };
  },
};

interface GridState {
  readonly held: number;
  readonly bottom: number | undefined;
  readonly reason: string;
}

interface GridConfig {
  readonly stepAtr: number;
  readonly levels: number;
  readonly stopLevels: number;
}

/**
 * Walks the grid forward one bar at a time. Each entry depends only on bars
 * up to and including its own, which is what keeps precomputing it causal.
 */
export function gridPath(
  candles: readonly Candle[],
  center: readonly (number | null)[],
  atrLine: readonly (number | null)[],
  config: GridConfig,
): (GridState | null)[] {
  const out: (GridState | null)[] = [];
  let anchor: { center: number; step: number } | null = null;
  let held = 0;
  let broken = false;

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;
    const mid = center[i];
    const a = atrLine[i];
    if (mid === null || mid === undefined || a === null || a === undefined || a <= 0) {
      out.push(null);
      continue;
    }

    if (anchor === null) {
      if (broken) {
        if (bar.close >= mid) broken = false;
        out.push({ held: 0, bottom: undefined, reason: 'range broke; waiting for recovery above average' });
        continue;
      }
      const step = config.stepAtr * a;
      const depth = (mid - bar.close) / step;
      if (depth >= 1 && depth < config.levels + config.stopLevels) {
        anchor = { center: mid, step };
        held = Math.min(config.levels, Math.floor(depth));
      } else {
        out.push({ held: 0, bottom: undefined, reason: 'price not a full step below average' });
        continue;
      }
    } else {
      const bottom = anchor.center - (config.levels + config.stopLevels) * anchor.step;
      if (bar.low <= bottom) {
        anchor = null;
        held = 0;
        broken = true;
        out.push({ held: 0, bottom: undefined, reason: 'range broke below the grid' });
        continue;
      }
      const depth = (anchor.center - bar.close) / anchor.step;
      if (Math.floor(depth) > held) {
        held = Math.min(config.levels, Math.floor(depth));
      } else if (depth < held - 1) {
        // A slice bought at level k sells only once price is back above level
        // k-1. Without that full step of hysteresis the grid pays fees to
        // round-trip every tick of noise around a single level.
        held = Math.max(0, Math.floor(depth) + 1);
      }
      if (held === 0) {
        anchor = null;
        out.push({ held: 0, bottom: undefined, reason: 'grid fully sold back above its anchor' });
        continue;
      }
    }

    const bottom = anchor.center - (config.levels + config.stopLevels) * anchor.step;
    out.push({ held, bottom, reason: `holding ${held}/${config.levels} grid levels` });
  }
  return out;
}
