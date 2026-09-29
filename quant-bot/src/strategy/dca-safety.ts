import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { closes, sma } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * The "DCA bot": open a small base order, add a safety order every time price
 * falls another `stepPct` below the cycle's starting price, and close the
 * whole cycle once price is `tpPct` above the average cost. Then start again.
 *
 * Averaging down lowers the break-even, so most cycles close green and the
 * win rate looks superb. The cost is hidden in the tail: a sustained decline
 * fills every safety order and then keeps going, and the one losing cycle is
 * several times the size of the typical win. Classic DCA bots have no stop at
 * all; `stopSteps` below the deepest safety order is the stop this one keeps,
 * and `trendPeriod` (0 disables it) refuses to open a new cycle below the
 * long average.
 */
export const dcaSafety: StrategyFactory = {
  name: 'dca-safety',
  defaults: { baseSlice: 0.2, maxSafety: 4, stepPct: 5, tpPct: 5, stopSteps: 2, trendPeriod: 200 },
  grid: {
    stepPct: [3, 5, 8],
    tpPct: [3, 5, 10],
    stopSteps: [1, 3],
    trendPeriod: [0, 200],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const config: DcaConfig = {
      baseSlice: param(params, 'baseSlice', 0.2),
      maxSafety: param(params, 'maxSafety', 4),
      stepPct: param(params, 'stepPct', 5),
      tpPct: param(params, 'tpPct', 5),
      stopSteps: param(params, 'stopSteps', 2),
      trendPeriod: param(params, 'trendPeriod', 200),
    };
    validate(config);

    const trend = config.trendPeriod > 0 ? sma(closes(candles), config.trendPeriod) : null;
    const path = dcaPath(candles, trend, config);

    return {
      name: 'dca-safety',
      params: { ...config },
      warmup: Math.max(config.trendPeriod, 1),
      signalAt(i: number, _position: Position | null): Signal {
        const state = path[i];
        if (!state) return FLAT;
        if (state.exposure === 0) return { target: 0, reason: state.reason };
        return { target: state.exposure, stopPrice: state.stop, reason: state.reason };
      },
    };
  },
};

export interface DcaConfig {
  readonly baseSlice: number;
  readonly maxSafety: number;
  readonly stepPct: number;
  readonly tpPct: number;
  readonly stopSteps: number;
  readonly trendPeriod: number;
}

function validate(c: DcaConfig): void {
  if (!(c.baseSlice > 0 && c.baseSlice <= 1)) {
    throw new RangeError(`dca-safety needs 0 < baseSlice <= 1, got ${c.baseSlice}`);
  }
  if (!Number.isInteger(c.maxSafety) || c.maxSafety < 0) {
    throw new RangeError(`dca-safety needs an integer maxSafety >= 0, got ${c.maxSafety}`);
  }
  if (c.maxSafety > 0 && (1 - c.baseSlice) / c.maxSafety < 0.1) {
    // Smaller safety orders fall under the engine's 10% rebalance threshold
    // and would never actually be placed.
    throw new RangeError('dca-safety safety orders must each be at least 10% of full size');
  }
  if (c.stepPct <= 0 || c.tpPct <= 0 || c.stopSteps <= 0) {
    throw new RangeError('dca-safety needs stepPct, tpPct and stopSteps > 0');
  }
  if (c.stepPct * (c.maxSafety + c.stopSteps) >= 100) {
    throw new RangeError('dca-safety stop would sit at or below zero; reduce stepPct or the step counts');
  }
  if (!Number.isInteger(c.trendPeriod) || c.trendPeriod < 0) {
    throw new RangeError(`dca-safety needs an integer trendPeriod >= 0, got ${c.trendPeriod}`);
  }
}

interface DcaState {
  readonly exposure: number;
  readonly stop: number | undefined;
  readonly reason: string;
}

/**
 * Replays the bot's cycle bar by bar. The average cost is tracked from the
 * trigger closes rather than the engine's fills so the path depends only on
 * prices, which keeps it causal and lets it be precomputed.
 */
export function dcaPath(
  candles: readonly Candle[],
  trend: readonly (number | null)[] | null,
  c: DcaConfig,
): (DcaState | null)[] {
  const safetySlice = c.maxSafety > 0 ? (1 - c.baseSlice) / c.maxSafety : 0;
  const out: (DcaState | null)[] = [];
  let cycle: { start: number; level: number; weight: number; cost: number; stop: number } | null = null;

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;
    const t = trend ? trend[i] : undefined;
    if (trend && (t === null || t === undefined)) {
      out.push(null);
      continue;
    }

    if (cycle !== null) {
      if (bar.low <= cycle.stop) {
        cycle = null;
        out.push({ exposure: 0, stop: undefined, reason: 'every safety order filled and the stop broke' });
        continue;
      }
      const average = cycle.cost / cycle.weight;
      if (bar.close >= average * (1 + c.tpPct / 100)) {
        cycle = null;
        out.push({ exposure: 0, stop: undefined, reason: `take profit ${c.tpPct}% above average cost` });
        continue;
      }
      while (cycle.level < c.maxSafety && bar.close <= cycle.start * (1 - (c.stepPct / 100) * (cycle.level + 1))) {
        cycle.level += 1;
        cycle.weight += safetySlice;
        cycle.cost += safetySlice * bar.close;
      }
    } else {
      if (t !== undefined && t !== null && bar.close < t) {
        out.push({ exposure: 0, stop: undefined, reason: 'below trend filter; no new cycle' });
        continue;
      }
      cycle = {
        start: bar.close,
        level: 0,
        weight: c.baseSlice,
        cost: c.baseSlice * bar.close,
        stop: bar.close * (1 - (c.stepPct / 100) * (c.maxSafety + c.stopSteps)),
      };
    }

    out.push({
      exposure: Math.min(1, c.baseSlice + cycle.level * safetySlice),
      stop: cycle.stop,
      reason: `cycle open, ${cycle.level}/${c.maxSafety} safety orders filled`,
    });
  }
  return out;
}
