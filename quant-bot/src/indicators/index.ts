import type { Candle } from '../domain/types.ts';

/**
 * Every indicator here returns an array the same length as its input, where
 * slot `i` is computed from inputs `0..i` only and is `null` until enough
 * history exists. That alignment is the whole point: it makes lookahead a
 * type-level impossibility at the call site rather than a review checklist
 * item, and `test/no-lookahead.test.ts` asserts it holds for every indicator.
 */
export type Series = readonly (number | null)[];

export function closes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values so the series does not
  // inherit an arbitrary bias from values[0].
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] as number;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI, the 14-period default every charting package agrees on. */
export function rsi(values: readonly number[], period = 14): Series {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = (values[i] as number) - (values[i - 1] as number);
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  gain /= period;
  loss /= period;
  out[period] = toRsi(gain, loss);
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = (values[i] as number) - (values[i - 1] as number);
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

function toRsi(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/**
 * Wilder's Average True Range. This is the bot's unit of risk: stops and
 * position sizes are both quoted in ATRs so that a volatile asset
 * automatically gets a smaller position rather than a bigger loss.
 */
export function atr(candles: readonly Candle[], period = 14): Series {
  assertPeriod(period);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i] as Candle;
    const prevClose = (candles[i - 1] as Candle).close;
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }
  let acc = 0;
  for (let i = 1; i <= period; i += 1) acc += tr[i] as number;
  let prev = acc / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + (tr[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

/** Highest value over the trailing `period` bars, inclusive of bar `i`. */
export function rollingMax(values: readonly number[], period: number): Series {
  return rollingExtreme(values, period, Math.max);
}

/** Lowest value over the trailing `period` bars, inclusive of bar `i`. */
export function rollingMin(values: readonly number[], period: number): Series {
  return rollingExtreme(values, period, Math.min);
}

function rollingExtreme(
  values: readonly number[],
  period: number,
  pick: (a: number, b: number) => number,
): Series {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    let best = values[i - period + 1] as number;
    for (let j = i - period + 2; j <= i; j += 1) best = pick(best, values[j] as number);
    out[i] = best;
  }
  return out;
}

/** Sample standard deviation over a trailing window. */
export function stdev(values: readonly number[], period: number): Series {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period < 2) return out;
  const means = sma(values, period);
  for (let i = period - 1; i < values.length; i += 1) {
    const mean = means[i];
    if (mean === null || mean === undefined) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = (values[j] as number) - mean;
      acc += d * d;
    }
    out[i] = Math.sqrt(acc / (period - 1));
  }
  return out;
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`indicator period must be a positive integer, got ${period}`);
  }
}

/** Log returns, aligned so slot `i` is the return from bar `i-1` to bar `i`. */
export function logReturns(values: readonly number[]): number[] {
  const out: number[] = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1] as number;
    const cur = values[i] as number;
    out[i] = prev > 0 && cur > 0 ? Math.log(cur / prev) : 0;
  }
  return out;
}

/**
 * Bars per year, inferred from the median spacing of the candles themselves.
 *
 * Taking the median rather than the mean keeps a single exchange outage or a
 * missing bar from halving the estimate, which would then halve every
 * annualised volatility computed from it.
 */
export function barsPerYear(candles: readonly Candle[]): number {
  if (candles.length < 2) return 365;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    gaps.push((candles[i] as Candle).time - (candles[i - 1] as Candle).time);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 86_400_000;
  return median > 0 ? (365 * 86_400_000) / median : 365;
}

/**
 * Wilder's Average Directional Index, alongside +DI/-DI. ADX measures trend
 * STRENGTH (how directional the market is), not direction — a market can
 * have a strong ADX reading while falling just as easily as while rising.
 * This is the textbook method for the "is this a trend or a chop" question,
 * predating any of the community range-detection scripts by decades.
 */
export function adx(candles: readonly Candle[], period = 14): {
  readonly adx: Series;
  readonly plusDI: Series;
  readonly minusDI: Series;
} {
  assertPeriod(period);
  const n = candles.length;
  const adxOut: (number | null)[] = new Array(n).fill(null);
  const plusDIOut: (number | null)[] = new Array(n).fill(null);
  const minusDIOut: (number | null)[] = new Array(n).fill(null);
  if (n <= period * 2) return { adx: adxOut, plusDI: plusDIOut, minusDI: minusDIOut };

  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const cur = candles[i] as Candle;
    const prev = candles[i - 1] as Candle;
    tr[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let trSum = 0;
  let plusDMSum = 0;
  let minusDMSum = 0;
  for (let i = 1; i <= period; i += 1) {
    trSum += tr[i] as number;
    plusDMSum += plusDM[i] as number;
    minusDMSum += minusDM[i] as number;
  }

  const dx: (number | null)[] = new Array(n).fill(null);
  const recordDI = (i: number): void => {
    const plusDI = trSum > 0 ? (100 * plusDMSum) / trSum : 0;
    const minusDI = trSum > 0 ? (100 * minusDMSum) / trSum : 0;
    plusDIOut[i] = plusDI;
    minusDIOut[i] = minusDI;
    const sum = plusDI + minusDI;
    dx[i] = sum > 0 ? (100 * Math.abs(plusDI - minusDI)) / sum : 0;
  };
  recordDI(period);

  for (let i = period + 1; i < n; i += 1) {
    trSum = trSum - trSum / period + (tr[i] as number);
    plusDMSum = plusDMSum - plusDMSum / period + (plusDM[i] as number);
    minusDMSum = minusDMSum - minusDMSum / period + (minusDM[i] as number);
    recordDI(i);
  }

  let adxSum = 0;
  let seeded = false;
  for (let i = period; i < n; i += 1) {
    const value = dx[i];
    if (value === null || value === undefined) continue;
    if (!seeded) {
      adxSum += value;
      // Wilder's ADX seeds from the simple average of the FIRST `period` DX
      // values, which are DX[period] .. DX[2*period - 1] -- period values,
      // not period + 1. Seeding one index later (2*period) summed an extra
      // term and inflated the very first ADX reading above the 0-100 bound
      // DX is otherwise guaranteed to respect.
      if (i === period * 2 - 1) {
        adxOut[i] = adxSum / period;
        seeded = true;
      }
    } else {
      const prevAdx = adxOut[i - 1] as number;
      adxOut[i] = (prevAdx * (period - 1) + value) / period;
    }
  }
  return { adx: adxOut, plusDI: plusDIOut, minusDI: minusDIOut };
}

/**
 * True Strength Index (William Blau, 1991): double-smoothed momentum.
 * Price change is EMA-smoothed twice (long period then short period), same
 * for its absolute value, and the ratio -- bounded to [-100, 100] because the
 * denominator can never be smaller than the numerator's absolute value --
 * reads as net directional momentum as a share of total movement.
 */
export function tsi(values: readonly number[], longPeriod = 25, shortPeriod = 13): Series {
  assertPeriod(longPeriod);
  assertPeriod(shortPeriod);
  const change: number[] = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i += 1) {
    change[i] = (values[i] as number) - (values[i - 1] as number);
  }
  const smoothedChange = ema(ema(change, longPeriod).map((v) => v ?? 0), shortPeriod);
  const smoothedAbsChange = ema(ema(change.map(Math.abs), longPeriod).map((v) => v ?? 0), shortPeriod);

  return values.map((_, i) => {
    const num = smoothedChange[i];
    const den = smoothedAbsChange[i];
    if (num === null || num === undefined || den === null || den === undefined) return null;
    return den > 0 ? (100 * num) / den : 0;
  });
}

/**
 * Trend Direction Force Index (Mladen): (close - prevClose) * volume,
 * normalized by ATR so the reading is comparable across assets and
 * volatility regimes, then EMA-smoothed. Published variants add further
 * min-max normalisation on top of this core formula; only the documented
 * core is implemented here rather than guessing at an unconfirmed extra
 * step -- consolidation still reads as values near zero either way, which
 * is the property this repo's use of it depends on.
 */
export function tdfi(candles: readonly Candle[], atrPeriod = 14, smoothPeriod = 13): Series {
  assertPeriod(atrPeriod);
  assertPeriod(smoothPeriod);
  const atrLine = atr(candles, atrPeriod);
  const force: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i += 1) {
    const cur = candles[i] as Candle;
    const prev = candles[i - 1] as Candle;
    const atrValue = atrLine[i];
    if (atrValue === null || atrValue === undefined || atrValue <= 0) continue;
    force[i] = ((cur.close - prev.close) * cur.volume) / atrValue;
  }
  return ema(force, smoothPeriod).map((v, i) => (atrLine[i] === null || atrLine[i] === undefined ? null : v));
}

/**
 * McGinley Dynamic (John McGinley, 1990): a moving average that adjusts its
 * own speed to price, via a recursive formula that accelerates on strong
 * moves and slows during consolidation -- aimed at the lag problem plain
 * SMA/EMA lines have. Seeded from the SMA of the first `period` values, the
 * same convention `ema` uses here, so it starts from a stable baseline
 * rather than the first raw price.
 */
export function mcginleyDynamic(values: readonly number[], period = 14): Series {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] as number;
  let md = seed / period;
  out[period - 1] = md;

  for (let i = period; i < values.length; i += 1) {
    const price = values[i] as number;
    if (md > 0) {
      const ratio = price / md;
      // A ratio of exactly 0 or a pathological spike raised to the 4th power
      // can blow the denominator up or collapse it; guard rather than emit
      // NaN/Infinity into a strategy that will trade on this value.
      const denominator = period * ratio ** 4;
      md = Number.isFinite(denominator) && denominator > 0
        ? md + (price - md) / denominator
        : price;
    } else {
      md = price;
    }
    out[i] = md;
  }
  return out;
}
