import { describe, expect, it } from 'vitest';
import { atr, ema, rollingMax, rollingMin, rsi, sma, stdev } from '../src/indicators/index.ts';
import type { Candle } from '../src/domain/types.ts';

const bars = (closes: number[]): Candle[] =>
  closes.map((close, i) => ({
    time: i * 86_400_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
  }));

describe('sma', () => {
  it('is null until the window is full, then averages the window', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });

  it('does not drift on long series', () => {
    const values = Array.from({ length: 500 }, (_, i) => i + 1);
    const out = sma(values, 10);
    expect(out[499]).toBeCloseTo(495.5, 9);
  });
});

describe('ema', () => {
  it('seeds from the SMA of the first window', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 10);
    // k = 2/(3+1) = 0.5
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it('converges to a constant input', () => {
    const out = ema(new Array(200).fill(7), 20);
    expect(out[199]).toBeCloseTo(7, 9);
  });
});

describe('rsi', () => {
  it('is 100 when every bar rises and 0 when every bar falls', () => {
    const up = rsi(Array.from({ length: 60 }, (_, i) => 100 + i), 14);
    expect(up[59]).toBeCloseTo(100, 6);
    const down = rsi(Array.from({ length: 60 }, (_, i) => 100 - i), 14);
    expect(down[59]).toBeCloseTo(0, 6);
  });

  it('stays within 0..100 on noisy input', () => {
    const noisy = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i) * 10);
    for (const value of rsi(noisy, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('atr', () => {
  it('equals the constant range when every bar has the same range', () => {
    const flat: Candle[] = Array.from({ length: 50 }, (_, i) => ({
      time: i * 86_400_000,
      open: 100,
      high: 102,
      low: 98,
      close: 100,
      volume: 1,
    }));
    expect(atr(flat, 14)[49]).toBeCloseTo(4, 6);
  });

  it('is null before the period has elapsed', () => {
    expect(atr(bars([1, 2, 3]), 14).every((v) => v === null)).toBe(true);
  });
});

describe('rolling extremes', () => {
  it('include the current bar', () => {
    expect(rollingMax([1, 5, 3, 2], 2)).toEqual([null, 5, 5, 3]);
    expect(rollingMin([1, 5, 3, 2], 2)).toEqual([null, 1, 3, 2]);
  });
});

describe('stdev', () => {
  it('is zero for a constant window', () => {
    expect(stdev([4, 4, 4, 4], 3)[3]).toBeCloseTo(0, 12);
  });

  it('matches the sample standard deviation', () => {
    // sample sd of [2,4,4,4,5,5,7,9] is 2.13809...
    const out = stdev([2, 4, 4, 4, 5, 5, 7, 9], 8);
    expect(out[7]).toBeCloseTo(2.13809, 4);
  });
});

describe('period validation', () => {
  it('rejects non-positive and fractional periods', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => ema([1, 2, 3], -1)).toThrow(RangeError);
    expect(() => atr(bars([1, 2, 3]), 1.5)).toThrow(RangeError);
  });
});
