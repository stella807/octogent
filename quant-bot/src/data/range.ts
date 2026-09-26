import { TIMEFRAME_MS, type Candle, type Timeframe } from '../domain/types.ts';

/** An optional UTC window over history. Either bound may be open. */
export interface DateRange {
  readonly since: number | undefined;
  readonly until: number | undefined;
}

/**
 * Parses `--since` / `--until`. A bare `YYYY-MM-DD` is read as UTC midnight
 * (which is what `Date.parse` does for date-only ISO strings), so a window
 * means the same bars regardless of the machine's timezone.
 */
export function parseRange(since: string | undefined, until: string | undefined): DateRange {
  return {
    since: parseBound(since, 'since'),
    until: parseBound(until, 'until'),
  };
}

function parseBound(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const time = Date.parse(value.trim());
  // Silently ignoring a typo would run the backtest over the wrong regime and
  // report it as if it were the one asked for.
  if (!Number.isFinite(time)) {
    throw new Error(`--${name} must be a date like 2021-11-01 or 2021-11-01T00:00:00Z, got "${value}"`);
  }
  return time;
}

/** Keeps bars whose open time falls inside the window, inclusive at both ends. */
export function clipToRange(candles: readonly Candle[], range: DateRange): Candle[] {
  const { since, until } = range;
  return candles.filter((c) =>
    (since === undefined || c.time >= since) && (until === undefined || c.time <= until));
}

/**
 * How many bars to request so the window is actually covered. The caller's
 * default is a floor, never a ceiling: asking for a year of daily bars with a
 * 100-bar default would otherwise quietly backtest the last 100 days.
 */
export function barsForRange(range: DateRange, timeframe: Timeframe, fallback: number): number {
  if (range.since === undefined) return fallback;
  const end = range.until ?? Date.now();
  // +2 covers the bar at each inclusive end of the window.
  const needed = Math.ceil(Math.max(0, end - range.since) / TIMEFRAME_MS[timeframe]) + 2;
  return Math.max(fallback, needed);
}
