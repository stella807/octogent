import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { alignSentiment, type SentimentPoint } from '../src/data/sentiment.ts';
import { donchianSentiment } from '../src/strategy/donchian-sentiment.ts';
import { donchianBreakout } from '../src/strategy/donchian-breakout.ts';
import { runBacktest, DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { FRICTIONLESS } from '../src/backtest/costs.ts';
import { BENCHMARK_LIMITS } from '../src/risk/risk-manager.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function ramp(values: number[]): Candle[] {
  return values.map((close, i) => ({
    time: T0 + i * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1,
  }));
}

const point = (dayOffset: number, value: number): SentimentPoint => ({
  time: T0 + dayOffset * DAY,
  value,
});

describe('alignSentiment', () => {
  it('gives bar i the PRIOR day\'s reading, never the same day\'s', () => {
    const candles = ramp([100, 100, 100]);
    // day 0 = 10, day 1 = 90, day 2 = 50 -- distinct values so misalignment
    // is unmistakable.
    const sentiment = [point(0, 10), point(1, 90), point(2, 50)];
    const aligned = alignSentiment(candles, sentiment);
    expect(aligned[0]).toBeNull(); // no day -1 reading exists
    expect(aligned[1]).toBe(10); // bar 1 (day 1) sees day 0's reading
    expect(aligned[2]).toBe(90); // bar 2 (day 2) sees day 1's reading
  });

  it('is null where no reading exists for the prior day, rather than guessing', () => {
    const candles = ramp([100, 100, 100]);
    const sparse = [point(0, 10)]; // day 1 and day 2 have no prior-day data
    const aligned = alignSentiment(candles, sparse);
    expect(aligned[1]).toBe(10);
    expect(aligned[2]).toBeNull();
  });

  it('never returns a reading whose own day is later than the bar it is attached to', () => {
    const candles = ramp(Array.from({ length: 30 }, () => 100));
    const sentiment = Array.from({ length: 40 }, (_, d) => point(d, d));
    const aligned = alignSentiment(candles, sentiment);
    for (let i = 0; i < candles.length; i += 1) {
      const reading = aligned[i];
      if (reading === null || reading === undefined) continue;
      const barDay = Math.floor((candles[i] as Candle).time / DAY);
      // The reading's own value IS the day-offset it was published on, by
      // construction above, so this directly checks the reading's source day
      // is strictly before the bar's day.
      expect(reading).toBeLessThan(barDay);
    }
  });
});

describe('donchian-sentiment gate', () => {
  const breakout = ramp([...new Array(200).fill(100), 130, 131, 132]);

  it('takes the breakout when sentiment is available and below the threshold', () => {
    const sentiment = breakout.map((c) => alignSentiment([c], [{ time: c.time - DAY, value: 40 }])[0] ?? null);
    const strategy = donchianSentiment.create(breakout, donchianSentiment.defaults, { sentiment });
    expect(strategy.signalAt(200, null).target).toBe(1);
  });

  it('skips the breakout when sentiment is at or above the greed threshold', () => {
    const sentiment = breakout.map((c) => alignSentiment([c], [{ time: c.time - DAY, value: 85 }])[0] ?? null);
    const strategy = donchianSentiment.create(breakout, donchianSentiment.defaults, { sentiment });
    const signal = strategy.signalAt(200, null);
    expect(signal.target).toBe(0);
    expect(signal.reason).toMatch(/extreme-greed threshold/);
  });

  it('behaves exactly like the ungated strategy when no sentiment context is given', () => {
    const withoutContext = donchianSentiment.create(breakout, donchianSentiment.defaults);
    const plain = donchianBreakout.create(breakout, donchianBreakout.defaults);
    expect(withoutContext.signalAt(200, null).target).toBe(plain.signalAt(200, null).target);
  });

  it('never blocks managing an existing position, only new entries', () => {
    const held: Position = {
      qty: 1, entryPrice: 100, entryTime: 0, stopPrice: 90, highWaterPrice: 132,
      realizedPnl: 0, feesPaid: 0, peakQty: 1, equityAtEntry: 10_000,
    };
    const sentiment = breakout.map(() => 99); // maximally greedy throughout
    const strategy = donchianSentiment.create(breakout, donchianSentiment.defaults, { sentiment });
    // Still long: the gate only ever stops a NEW entry.
    expect(strategy.signalAt(200, held).target).toBe(1);
  });

  it('treats a missing reading as "no gate", not as a block', () => {
    const sentiment = breakout.map(() => null);
    const strategy = donchianSentiment.create(breakout, donchianSentiment.defaults, { sentiment });
    expect(strategy.signalAt(200, null).target).toBe(1);
  });

  it('cannot see the future through the sentiment channel either', () => {
    const sentiment = breakout.map((_, i) => (i % 2 === 0 ? 20 : 95));
    const full = donchianSentiment.create(breakout, donchianSentiment.defaults, { sentiment });
    const prefix = donchianSentiment.create(
      breakout.slice(0, 201),
      donchianSentiment.defaults,
      { sentiment: sentiment.slice(0, 201) },
    );
    expect(prefix.signalAt(200, null)).toEqual(full.signalAt(200, null));
  });
});

describe('donchian-sentiment end to end', () => {
  it('produces a strictly different, valid backtest when the gate actually fires', () => {
    const candles = ramp([...new Array(200).fill(100), 130, 131, 132, 133, 134]);
    // The ramp keeps making new highs bar after bar (130 < 131 < 132 ...), so
    // a breakout condition re-triggers on every bar in that region once the
    // channel catches up -- gating a single bar would just delay entry by
    // one bar, not prevent it. Greedy for the whole breakout region is the
    // fixture that actually isolates "the gate blocked every attempt".
    const sentiment = candles.map((_, i) => (i >= 200 ? 95 : 40));
    const config = { ...DEFAULT_CONFIG, costs: FRICTIONLESS, limits: BENCHMARK_LIMITS };

    const gated = runBacktest(
      candles,
      donchianSentiment.create(candles, donchianSentiment.defaults, { sentiment }),
      config,
    );
    const ungated = runBacktest(
      candles,
      donchianBreakout.create(candles, donchianBreakout.defaults),
      config,
    );
    // The gate skips the one breakout in this series; the ungated version takes it.
    expect(gated.trades).toHaveLength(0);
    expect(ungated.trades.length).toBeGreaterThan(0);
  });
});
