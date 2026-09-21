import { describe, expect, it } from 'vitest';
import type { Candle, Position, Signal } from '../src/domain/types.ts';
import { DEFAULT_CONFIG, runBacktest, type BacktestConfig } from '../src/backtest/engine.ts';
import { DEFAULT_COSTS, FRICTIONLESS } from '../src/backtest/costs.ts';
import { BENCHMARK_LIMITS } from '../src/risk/risk-manager.ts';
import type { Strategy } from '../src/strategy/types.ts';

const DAY = 86_400_000;

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: Date.UTC(2024, 0, 1) + i * DAY, open: o, high: h, low: l, close: c, volume: 1 };
}

/** A strategy driven by an explicit per-bar script, so fills can be asserted exactly. */
function scripted(script: readonly (Signal | null)[], warmup = 0): Strategy {
  return {
    name: 'scripted',
    params: {},
    warmup,
    signalAt: (i: number, _position: Position | null) => script[i] ?? { target: 0 },
  };
}

const config: BacktestConfig = {
  ...DEFAULT_CONFIG,
  startingEquity: 10_000,
  costs: FRICTIONLESS,
  limits: BENCHMARK_LIMITS,
};

describe('fill timing', () => {
  it('fills a signal from bar i at the OPEN of bar i+1, never bar i', () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 200, 201, 199, 200), // the bar whose open must be the entry price
      bar(3, 200, 201, 199, 200),
      bar(4, 300, 301, 299, 300), // and whose open must be the exit price
    ];
    // Long from bar 1's close, flat from bar 3's close.
    const result = runBacktest(candles, scripted([
      { target: 0 },
      { target: 1 },
      { target: 1 },
      { target: 0 },
      { target: 0 },
    ]), config);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade?.entryPrice).toBeCloseTo(200, 10);
    expect(trade?.exitPrice).toBeCloseTo(300, 10);
    expect(trade?.exitReason).toBe('signal');
  });

  it('never opens a position on the final bar, where it could not be filled', () => {
    const candles = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100)];
    const result = runBacktest(candles, scripted([{ target: 1 }, { target: 1 }]), config);
    // Bar 0's signal fills at bar 1's open; bar 1's signal is never queued.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe('end-of-data');
  });
});

describe('stops', () => {
  it('fills at the stop price when the bar trades through it', () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 100, 101, 90, 92), // low pierces the stop at 95
      bar(3, 92, 93, 91, 92),
    ];
    const result = runBacktest(candles, scripted([
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 95 },
    ]), config);

    expect(result.trades[0]?.exitReason).toBe('stop');
    expect(result.trades[0]?.exitPrice).toBeCloseTo(95, 10);
  });

  it('fills at the gapped open, not the stop, when price opens below the stop', () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 80, 82, 78, 79), // gaps straight through the 95 stop
      bar(3, 79, 80, 78, 79),
    ];
    const result = runBacktest(candles, scripted([
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 95 },
    ]), config);

    // Assuming the stop filled at 95 here would invent money that never existed.
    expect(result.trades[0]?.exitPrice).toBeCloseTo(80, 10);
    expect(result.trades[0]?.pnl).toBeLessThan(0);
  });

  it('ratchets a stop upward and refuses to loosen it', () => {
    const candles = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100),
      bar(2, 120, 121, 119, 120),
      bar(3, 120, 121, 96, 120), // would hit a loosened stop of 95, not the ratcheted 110
      bar(4, 120, 121, 119, 120),
    ];
    const result = runBacktest(candles, scripted([
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 110 },
      { target: 1, stopPrice: 95 }, // attempt to loosen
      { target: 1, stopPrice: 95 },
      { target: 1, stopPrice: 95 },
    ]), config);

    expect(result.trades[0]?.exitReason).toBe('stop');
    expect(result.trades[0]?.exitPrice).toBeCloseTo(110, 10);
  });
});

describe('costs', () => {
  it('charges fees and slippage on both sides of a round trip', () => {
    const flat = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)];
    const script = scripted([{ target: 1 }, { target: 0 }, { target: 0 }]);

    const free = runBacktest(flat, script, config);
    const costed = runBacktest(flat, script, { ...config, costs: DEFAULT_COSTS });

    expect(free.trades[0]?.pnl).toBeCloseTo(0, 6);
    // Buying and selling at the same price must lose exactly the round trip.
    expect(costed.trades[0]?.pnl).toBeLessThan(0);
    expect(costed.trades[0]?.fees).toBeGreaterThan(0);
  });

  it('never spends more cash than the account holds', () => {
    const candles = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100));
    const result = runBacktest(candles, scripted(new Array(20).fill({ target: 1 })), {
      ...config,
      costs: DEFAULT_COSTS,
    });
    for (const point of result.equityCurve) expect(point.equity).toBeGreaterThan(0);
  });
});

describe('input validation', () => {
  it('rejects out-of-order candles rather than silently mis-simulating them', () => {
    const candles = [bar(0, 100, 101, 99, 100), bar(0, 100, 101, 99, 100)];
    expect(() => runBacktest(candles, scripted([]), config)).toThrow(RangeError);
  });

  it('rejects a non-positive starting equity', () => {
    expect(() => runBacktest([bar(0, 1, 1, 1, 1)], scripted([]), { ...config, startingEquity: 0 }))
      .toThrow(RangeError);
  });
});
