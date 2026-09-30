import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { trendHold } from '../src/strategy/trend-hold.ts';
import { DEFAULT_CONFIG, runBacktest } from '../src/backtest/engine.ts';
import { generateCandles } from '../src/data/synthetic.ts';

const DAY = 86_400_000;
const closes = (values: number[]): Candle[] =>
  values.map((close, i) => ({ time: i * DAY, open: close, high: close, low: close, close, volume: 1 }));
const held: Position = {
  qty: 1, entryPrice: 100, entryTime: 0, stopPrice: undefined, highWaterPrice: 100, realizedPnl: 0, feesPaid: 0,
} as Position;

describe('trend-hold', () => {
  // Average of the last 4 closes; the band is 10%.
  const params = { period: 4, bandPct: 10 };

  it('enters only once price clears the average by the band', () => {
    // Bar 4: 105 vs average 101.25 (needs 111.4). Bar 5: 130 vs average 108.75 (needs 119.6).
    const s = trendHold.create(closes([100, 100, 100, 100, 105, 130]), params);
    expect(s.signalAt(3, null).target).toBe(0);
    expect(s.signalAt(4, null).target).toBe(0);
    expect(s.signalAt(5, null).target).toBe(1);
  });

  it('holds through a dip inside the band and exits below it', () => {
    const s = trendHold.create(closes([100, 100, 100, 100, 95, 80]), params);
    expect(s.signalAt(4, held).target).toBe(1);
    expect(s.signalAt(5, held).target).toBe(0);
  });

  it('sets no tight stop, so the position limit sizes it rather than 1% risk', () => {
    const s = trendHold.create(closes([100, 100, 100, 100, 120]), params);
    expect(s.signalAt(4, null).stopPrice).toBeUndefined();
  });

  it('holds nearly the whole account through a steady uptrend', () => {
    const rising = closes(Array.from({ length: 400 }, (_, i) => 100 * 1.003 ** i));
    const r = runBacktest(rising, trendHold.create(rising, { period: 50, bandPct: 2 }), DEFAULT_CONFIG);
    const late = r.equityCurve.slice(100);
    expect(late.every((p) => p.exposure > 0.9)).toBe(true);
    expect(r.trades.length).toBeLessThanOrEqual(1);
  });

  it('stays in cash through a steady decline', () => {
    const falling = generateCandles({ bars: 1500, timeframe: '1d', seed: 11 });
    expect((falling[1499] as Candle).close).toBeLessThan((falling[0] as Candle).close / 5);
    const r = runBacktest(falling, trendHold.create(falling, trendHold.defaults), DEFAULT_CONFIG);
    expect(r.endingEquity).toBeGreaterThan(r.startingEquity * 0.8);
  });
});
