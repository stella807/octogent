import type { Candle } from '../domain/types.ts';

export interface AlignedSeries {
  readonly symbols: readonly string[];
  readonly times: readonly number[];
  /** `bars[symbolIndex][barIndex]`, every row the same length as `times`. */
  readonly bars: readonly (readonly Candle[])[];
}

/**
 * Aligns several symbols onto one timestamp grid by intersection.
 *
 * Inner join rather than forward fill, deliberately. Carrying a stale price
 * forward across a gap invents a bar that never traded, and the engine would
 * happily fill an order at it. Dropping the timestamp costs a little history
 * and keeps every price in the simulation one that actually existed.
 */
export function alignCandles(input: ReadonlyMap<string, readonly Candle[]>): AlignedSeries {
  const symbols = [...input.keys()];
  if (symbols.length === 0) {
    throw new RangeError('alignCandles needs at least one symbol');
  }

  const byTime = new Map<string, Map<number, Candle>>();
  for (const [symbol, candles] of input) {
    if (candles.length === 0) throw new RangeError(`no candles for ${symbol}`);
    byTime.set(symbol, new Map(candles.map((c) => [c.time, c])));
  }

  const first = symbols[0] as string;
  let times = [...(byTime.get(first) as Map<number, Candle>).keys()];
  for (const symbol of symbols.slice(1)) {
    const index = byTime.get(symbol) as Map<number, Candle>;
    times = times.filter((t) => index.has(t));
  }
  times.sort((a, b) => a - b);

  if (times.length === 0) {
    throw new RangeError(
      `symbols ${symbols.join(', ')} share no common timestamps; check the exchange and timeframe`,
    );
  }

  const bars = symbols.map((symbol) => {
    const index = byTime.get(symbol) as Map<number, Candle>;
    return times.map((t) => index.get(t) as Candle);
  });

  return { symbols, times, bars };
}

/** Fraction of each symbol's own history that survived the intersection. */
export function alignmentCoverage(
  input: ReadonlyMap<string, readonly Candle[]>,
  aligned: AlignedSeries,
): Map<string, number> {
  const coverage = new Map<string, number>();
  for (const [symbol, candles] of input) {
    coverage.set(symbol, candles.length > 0 ? aligned.times.length / candles.length : 0);
  }
  return coverage;
}
