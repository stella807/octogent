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
