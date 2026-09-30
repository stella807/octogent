import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { trendHold } from '../src/strategy/trend-hold.ts';
import { trendHoldDual, trendHoldSlope, trendHoldTrail } from '../src/strategy/trend-hold-variants.ts';

const DAY = 86_400_000;
const bars = (values: number[]): Candle[] =>
  values.map((c, i) => ({ time: i * DAY, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 }));
const held = (highWaterPrice: number): Position => ({
  qty: 1, entryPrice: 100, entryTime: 0, stopPrice: undefined, highWaterPrice, realizedPnl: 0, feesPaid: 0,
} as Position);

// A long climb, so every variant is in a clear uptrend by the end.
const rising = bars(Array.from({ length: 120 }, (_, i) => 100 * 1.01 ** i));

describe('trend-hold variants', () => {
  it('never set a stop price, which would shrink the position to a sliver', () => {
    for (const f of [trendHoldDual, trendHoldTrail, trendHoldSlope]) {
      const s = f.create(rising, { period: 20, bandPct: 0, fast: 5, slopeBars: 5 });
      expect(s.signalAt(100, null).stopPrice).toBeUndefined();
      expect(s.signalAt(100, held(300)).stopPrice).toBeUndefined();
    }
  });

  it('agree with trend-hold in a clean uptrend', () => {
    const base = trendHold.create(rising, { period: 20, bandPct: 0 }).signalAt(100, null).target;
    expect(base).toBe(1);
    for (const f of [trendHoldDual, trendHoldTrail, trendHoldSlope]) {
      expect(f.create(rising, { period: 20, bandPct: 0, fast: 5, slopeBars: 5 }).signalAt(100, null).target).toBe(1);
    }
  });

  it('dual: waits until the fast average is above the slow one', () => {
    // A slump, then one bar back above the slow average (99.3): price clears it, but the
    // 3-bar average (93.7) is still below it, so the trend is not yet confirmed.
    const bounce = bars([...Array.from({ length: 40 }, () => 100), 90, 90, 90, 101]);
    const i = bounce.length - 1;
    expect(trendHold.create(bounce, { period: 40, bandPct: 0 }).signalAt(i, null).target).toBe(1);
    expect(trendHoldDual.create(bounce, { period: 40, bandPct: 0, fast: 3 }).signalAt(i, null).target).toBe(0);
  });

  it('slope: refuses to enter while the slow average is not rising', () => {
    // A long slide from 200 to 100, then a spike to 300. Price is far above the 20-bar
    // average, but that average is still lower than 10 bars ago because the slide is
    // rolling out of it.
    const slide = bars([...Array.from({ length: 60 }, (_, i) => 200 - (100 * i) / 59), 300]);
    expect(trendHold.create(slide, { period: 20, bandPct: 0 }).signalAt(60, null).target).toBe(1);
    expect(trendHoldSlope.create(slide, { period: 20, bandPct: 0, slopeBars: 10 }).signalAt(60, null).target).toBe(0);
    // In a steady climb the same average is rising, so it enters.
    expect(trendHoldSlope.create(rising, { period: 20, bandPct: 0, slopeBars: 10 }).signalAt(100, null).target).toBe(1);
  });

  it('trail: exits after a fall from the high that trend-hold would sit through', () => {
    // A calm 1%-a-bar climb (tiny daily ranges), then a 7% drop. The 20-bar average lags
    // ~9% below the top, so trend-hold's own exit does not fire, but the drop is several
    // times the typical daily range.
    const climb = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
    const top = climb[climb.length - 1] as number;
    const calm = (v: number): Candle => ({ time: 0, open: v, high: v * 1.001, low: v * 0.999, close: v, volume: 1 });
    const dip = [...climb, top * 0.93].map((v, i) => ({ ...calm(v), time: i * DAY }));
    const i = dip.length - 1;
    const trail = trendHoldTrail.create(dip, { period: 20, bandPct: 2, atrPeriod: 5, atrMult: 2 });
    const plain = trendHold.create(dip, { period: 20, bandPct: 2 });
    expect(plain.signalAt(i, held(top)).target).toBe(1);
    expect(trail.signalAt(i, held(top)).target).toBe(0);
    expect(trail.signalAt(i, held(top)).reason).toMatch(/ranges from its high/);
  });

  it('reject nonsense parameters', () => {
    expect(() => trendHoldDual.create(rising, { period: 20, fast: 20 })).toThrow(/fast < period/);
    expect(() => trendHoldTrail.create(rising, { atrMult: 0 })).toThrow(/atrMult > 0/);
    expect(() => trendHoldSlope.create(rising, { slopeBars: 0 })).toThrow(/slopeBars >= 1/);
  });
});
