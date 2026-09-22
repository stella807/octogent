import type { Candle, Timeframe } from '../domain/types.ts';
import { TIMEFRAME_MS } from '../domain/types.ts';

export interface DateRange {
  readonly since: number | undefined;
  readonly until: number | undefined;
}

/**
 * Parses `--since` / `--until`.
 *
 * These exist because every backtest in this repo otherwise ends today, and a
 * window ending at an all-time high flatters everything in it. Being able to
 * run a strategy over Nov 2021 - Dec 2022 alone is the difference between
 * "this works" and "this worked during a bull market".
 */
export function parseRange(since: string | undefined, until: string | undefined): DateRange {
  return { since: parseDate(since, 'since'), until: parseDate(until, 'until') };
}

function parseDate(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  // Bare dates are read as UTC midnight; letting the local zone decide would
  // make the same command return different bars on different machines.
  const normalised = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const parsed = Date.parse(normalised);
  if (Number.isNaN(parsed)) {
    throw new Error(`--${name} must be a date like 2021-11-01, got "${value}"`);
  }
  return parsed;
}

/** Applies a range to candles already in memory (CSV and synthetic sources). */
export function clipToRange(candles: readonly Candle[], range: DateRange): Candle[] {
  const since = range.since ?? Number.NEGATIVE_INFINITY;
  const until = range.until ?? Number.POSITIVE_INFINITY;
  return candles.filter((c) => c.time >= since && c.time <= until);
}

/**
 * Bars needed to span a range, so `--since`/`--until` does not silently get
 * truncated by the default `--bars` cap.
 */
export function barsForRange(range: DateRange, timeframe: Timeframe, fallback: number): number {
  if (range.since === undefined) return fallback;
  const end = range.until ?? Date.now();
  const needed = Math.ceil((end - range.since) / TIMEFRAME_MS[timeframe]) + 2;
  return Math.max(needed, fallback);
}
