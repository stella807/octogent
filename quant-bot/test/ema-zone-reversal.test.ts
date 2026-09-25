import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { emaZoneReversal } from '../src/strategy/ema-zone-reversal.ts';

const DAY = 86_400_000;

function bar(i: number, close: number): Candle {
  return { time: i * DAY, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 };
}

function uptrendWithPullback(n: number, pullbackAt: number, pullbackDepth: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    let close = 100 + i * 0.8;
    if (i >= pullbackAt && i < pullbackAt + 5) close -= pullbackDepth;
    return bar(i, close);
  });
}

const held: Position = {
  qty: 1, entryPrice: 100, entryTime: 0, stopPrice: 90, highWaterPrice: 150,
  realizedPnl: 0, feesPaid: 0, peakQty: 1, equityAtEntry: 10_000,
};

describe('ema-zone-reversal', () => {
  it('buys the bounce off the zone after a pullback in an established uptrend', () => {
    const candles = uptrendWithPullback(200, 150, 15);
    const strategy = emaZoneReversal.create(candles, emaZoneReversal.defaults);
    // Somewhere after the pullback bars, price should have re-closed above
    // the fast EMA while the zone was recently touched.
    const signals = Array.from({ length: 20 }, (_, k) => strategy.signalAt(150 + k, null));
    expect(signals.some((s) => s.target === 1)).toBe(true);
  });

  it('does not enter on a pullback with no established uptrend', () => {
    const flat = Array.from({ length: 200 }, (_, i) => bar(i, 100 + Math.sin(i / 5) * 2));
    const strategy = emaZoneReversal.create(flat, emaZoneReversal.defaults);
    for (let i = 100; i < 200; i += 1) {
      expect(strategy.signalAt(i, null).target).toBe(0);
    }
  });

  it('requires an actual touch of the zone, not just any uptrend bar', () => {
    // A smooth uptrend with no pullback never touches its own EMA zone from
    // above after the initial warmup climb, so it should not spuriously enter
    // on every bar just because the trend is up.
    const smooth = Array.from({ length: 200 }, (_, i) => bar(i, 100 + i * 2));
    const strategy = emaZoneReversal.create(smooth, emaZoneReversal.defaults);
    const entries = Array.from({ length: 100 }, (_, k) => strategy.signalAt(100 + k, null))
      .filter((s) => s.target === 1).length;
    // Some bars may legitimately touch as the EMAs catch up early on, but it
    // must not be every single bar -- that would mean the "touch" check does
    // nothing.
    expect(entries).toBeLessThan(50);
  });

  it('exits when the zone breaks down (support fails)', () => {
    const candles = [
      ...uptrendWithPullback(150, 100, 10),
      ...Array.from({ length: 50 }, (_, i) => bar(150 + i, 175 - i * 3)), // sharp breakdown
    ];
    const strategy = emaZoneReversal.create(candles, emaZoneReversal.defaults);
    const signal = strategy.signalAt(180, held);
    expect(signal.target).toBe(0);
  });

  it('never lowers an existing stop', () => {
    const candles = uptrendWithPullback(200, 150, 15);
    const strategy = emaZoneReversal.create(candles, emaZoneReversal.defaults);
    const high = 200;
    const result = strategy.signalAt(199, { ...held, stopPrice: high });
    if (result.target === 1) expect(result.stopPrice).toBeGreaterThanOrEqual(high);
  });

  it('is flat during warmup', () => {
    const candles = uptrendWithPullback(200, 150, 15);
    expect(emaZoneReversal.create(candles, emaZoneReversal.defaults).signalAt(5, null).target).toBe(0);
  });

  it('rejects fastPeriod >= slowPeriod', () => {
    expect(() => emaZoneReversal.create([], { fastPeriod: 50, slowPeriod: 50 }))
      .toThrow(/fastPeriod < slowPeriod/);
  });

  it('cannot see the future', () => {
    const candles = uptrendWithPullback(200, 150, 15);
    const full = emaZoneReversal.create(candles, emaZoneReversal.defaults);
    const prefix = emaZoneReversal.create(candles.slice(0, 171), emaZoneReversal.defaults);
    expect(prefix.signalAt(170, null)).toEqual(full.signalAt(170, null));
  });
});
