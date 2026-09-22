import { describe, expect, it } from 'vitest';
import { barsForRange, clipToRange, parseRange } from '../src/data/range.ts';
import { generateCandles } from '../src/data/synthetic.ts';

const DAY = 86_400_000;

describe('parseRange', () => {
  it('reads a bare date as UTC midnight, not local midnight', () => {
    const { since } = parseRange('2021-11-01', undefined);
    expect(since).toBe(Date.UTC(2021, 10, 1));
  });

  it('accepts a full ISO timestamp', () => {
    expect(parseRange('2021-11-01T12:00:00Z', undefined).since)
      .toBe(Date.UTC(2021, 10, 1, 12));
  });

  it('leaves an omitted bound undefined', () => {
    expect(parseRange(undefined, undefined)).toEqual({ since: undefined, until: undefined });
  });

  it('rejects an unparseable date rather than silently ignoring it', () => {
    expect(() => parseRange('last tuesday', undefined)).toThrow(/--since must be a date/);
    expect(() => parseRange(undefined, 'soon')).toThrow(/--until must be a date/);
  });
});

describe('clipToRange', () => {
  const candles = generateCandles({ bars: 100, startTime: Date.UTC(2024, 0, 1) });

  it('keeps only bars inside the window, inclusive at both ends', () => {
    const range = { since: Date.UTC(2024, 0, 10), until: Date.UTC(2024, 0, 20) };
    const clipped = clipToRange(candles, range);
    expect(clipped).toHaveLength(11);
    expect(clipped[0]?.time).toBe(range.since);
    expect(clipped.at(-1)?.time).toBe(range.until);
  });

  it('is a no-op when neither bound is set', () => {
    expect(clipToRange(candles, { since: undefined, until: undefined })).toHaveLength(100);
  });

  it('returns empty rather than throwing when the window misses the data', () => {
    expect(clipToRange(candles, {
      since: Date.UTC(2030, 0, 1),
      until: Date.UTC(2030, 0, 2),
    })).toHaveLength(0);
  });
});

describe('barsForRange', () => {
  it('widens the bar count to span the requested window', () => {
    const range = { since: Date.UTC(2020, 0, 1), until: Date.UTC(2021, 0, 1) };
    // A year of daily bars cannot be served by the default 100-bar cap.
    expect(barsForRange(range, '1d', 100)).toBeGreaterThan(360);
  });

  it('scales with the timeframe', () => {
    const range = { since: Date.UTC(2024, 0, 1), until: Date.UTC(2024, 0, 11) };
    expect(barsForRange(range, '1h', 10)).toBeGreaterThan(barsForRange(range, '1d', 10));
    expect(barsForRange(range, '1d', 10)).toBeCloseTo(10 * (DAY / DAY) + 2, 0);
  });

  it('keeps the caller default when no start is given', () => {
    expect(barsForRange({ since: undefined, until: undefined }, '1d', 1500)).toBe(1500);
  });

  it('never shrinks below the caller default', () => {
    const range = { since: Date.UTC(2024, 0, 1), until: Date.UTC(2024, 0, 3) };
    expect(barsForRange(range, '1d', 500)).toBe(500);
  });
});
