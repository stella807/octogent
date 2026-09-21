import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { volTarget } from '../src/strategy/index.ts';
import { barsPerYear, logReturns } from '../src/indicators/index.ts';

const DAY = 86_400_000;

/** A series whose bar-to-bar moves are a fixed percentage, alternating sign. */
function wobble(bars: number, movePct: number, drift: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < bars; i += 1) {
    const open = price;
    price = open * (1 + (i % 2 === 0 ? movePct : -movePct) / 100 + drift);
    out.push({
      time: i * DAY,
      open,
      high: Math.max(open, price) * 1.001,
      low: Math.min(open, price) * 0.999,
      close: price,
      volume: 1,
    });
  }
  return out;
}

describe('logReturns', () => {
  it('is zero on the first bar and additive across bars', () => {
    const r = logReturns([100, 110, 121]);
    expect(r[0]).toBe(0);
    expect((r[1] as number) + (r[2] as number)).toBeCloseTo(Math.log(1.21), 9);
  });

  it('treats a non-positive price as no move rather than -Infinity', () => {
    expect(logReturns([100, 0, 50]).every(Number.isFinite)).toBe(true);
  });
});

describe('barsPerYear', () => {
  it('infers the timeframe from the candle spacing', () => {
    const daily = Array.from({ length: 10 }, (_, i) => ({
      time: i * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1,
    }));
    expect(barsPerYear(daily)).toBeCloseTo(365, 6);
  });

  it('uses the median so one gap does not halve the estimate', () => {
    const withGap = [0, 1, 2, 3, 9].map((d) => ({
      time: d * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1,
    }));
    expect(barsPerYear(withGap)).toBeCloseTo(365, 6);
  });
});

describe('vol-target', () => {
  it('holds a smaller position when realised volatility is higher', () => {
    const calm = wobble(400, 1, 0.004);
    const wild = wobble(400, 6, 0.004);
    const calmTarget = volTarget.create(calm, volTarget.defaults).signalAt(399, null).target;
    const wildTarget = volTarget.create(wild, volTarget.defaults).signalAt(399, null).target;
    expect(calmTarget).toBeGreaterThan(wildTarget);
    expect(wildTarget).toBeGreaterThan(0);
  });

  it('scales roughly inversely with volatility', () => {
    const slow = wobble(400, 2, 0.004);
    const fast = wobble(400, 4, 0.004);
    const a = volTarget.create(slow, { ...volTarget.defaults, maxExposure: 1 })
      .signalAt(399, null).target;
    const b = volTarget.create(fast, { ...volTarget.defaults, maxExposure: 1 })
      .signalAt(399, null).target;
    // Doubling volatility should roughly halve exposure, within a wide band.
    expect(b).toBeGreaterThan(a / 3);
    expect(b).toBeLessThan(a / 1.2);
  });

  it('never exceeds maxExposure, because this is spot with no leverage', () => {
    const veryCalm = wobble(400, 0.05, 0.0005);
    const signal = volTarget.create(veryCalm, { ...volTarget.defaults, maxExposure: 0.6 })
      .signalAt(399, null);
    expect(signal.target).toBeLessThanOrEqual(0.6);
  });

  it('goes flat below the trend filter', () => {
    const falling = wobble(400, 1, -0.004);
    const signal = volTarget.create(falling, volTarget.defaults).signalAt(399, null);
    expect(signal.target).toBe(0);
    expect(signal.reason).toMatch(/below trend filter/);
  });

  it('is flat during warmup', () => {
    const series = wobble(400, 1, 0.004);
    expect(volTarget.create(series, volTarget.defaults).signalAt(5, null).target).toBe(0);
  });

  it('refuses to size when measured volatility is zero', () => {
    const frozen: Candle[] = Array.from({ length: 400 }, (_, i) => ({
      time: i * DAY, open: 100, high: 100, low: 100, close: 100, volume: 1,
    }));
    const signal = volTarget.create(frozen, volTarget.defaults).signalAt(399, null);
    // A flat window is a data artefact, not a risk-free asset to lever into.
    expect(signal.target).toBe(0);
  });

  it('rejects leverage and nonsense targets', () => {
    const series = wobble(400, 1, 0.004);
    expect(() => volTarget.create(series, { ...volTarget.defaults, maxExposure: 2 }))
      .toThrow(/no leverage/);
    expect(() => volTarget.create(series, { ...volTarget.defaults, targetVolPct: 0 }))
      .toThrow(RangeError);
  });

  it('cannot see the future', () => {
    const series = wobble(400, 2, 0.004);
    const full = volTarget.create(series, volTarget.defaults);
    const prefix = volTarget.create(series.slice(0, 301), volTarget.defaults);
    expect(prefix.signalAt(300, null)).toEqual(full.signalAt(300, null));
  });
});
