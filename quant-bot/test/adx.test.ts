import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { adx } from '../src/indicators/index.ts';

const DAY = 86_400_000;

function trending(n: number, slope = 1.5): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * slope;
    return { time: i * DAY, open: close - 1, high: close + 1, low: close - 2, close, volume: 1 };
  });
}
function ranging(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 2;
    return { time: i * DAY, open: close - 0.5, high: close + 0.5, low: close - 1, close, volume: 1 };
  });
}

describe('adx', () => {
  it('reads high on a strong trend and low on a chop', () => {
    const t = adx(trending(100), 14);
    const r = adx(ranging(100), 14);
    expect(t.adx[99]).toBeGreaterThan(50);
    expect(r.adx[99]).toBeLessThan(30);
    expect(t.adx[99] as number).toBeGreaterThan(r.adx[99] as number);
  });

  it('assigns +DI to an uptrend and -DI to a downtrend', () => {
    const up = adx(trending(100, 1.5), 14);
    const down = adx(trending(100, -1.5), 14);
    expect(up.plusDI[99] as number).toBeGreaterThan(up.minusDI[99] as number);
    expect(down.minusDI[99] as number).toBeGreaterThan(down.plusDI[99] as number);
  });

  it('is null before enough history exists', () => {
    const short = adx(trending(20), 14);
    expect(short.adx.every((v) => v === null)).toBe(true);
  });

  it('stays within 0..100', () => {
    const candles = trending(300);
    for (const v of adx(candles, 14).adx) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('rejects a non-positive period', () => {
    expect(() => adx(trending(50), 0)).toThrow(RangeError);
  });
});
