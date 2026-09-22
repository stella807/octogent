import { describe, expect, it } from 'vitest';
import type { Candle, Position, Signal } from '../src/domain/types.ts';
import { DEFAULT_CONFIG, runBacktest, type BacktestConfig } from '../src/backtest/engine.ts';
import { DEFAULT_COSTS, FRICTIONLESS, minimumViableEquity } from '../src/backtest/costs.ts';
import { BENCHMARK_LIMITS, DEFAULT_LIMITS } from '../src/risk/risk-manager.ts';
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

describe('fractional exposure', () => {
  const flat = Array.from({ length: 30 }, (_, i) => bar(i, 100, 101, 99, 100));

  /** Exposure recorded once the position is established. */
  const settledExposure = (target: number): number => {
    const result = runBacktest(flat, scripted(new Array(30).fill({ target, stopPrice: 50 })), {
      ...config,
      limits: { ...DEFAULT_LIMITS, riskPerTradePct: 5, maxPositionPct: 100 },
    });
    return result.equityCurve[20]?.exposure ?? 0;
  };

  it('scales the position by the requested target', () => {
    const full = settledExposure(1);
    const half = settledExposure(0.5);
    expect(full).toBeGreaterThan(0);
    expect(half).toBeCloseTo(full / 2, 6);
  });

  it('treats a target above 1 as fully invested rather than levered', () => {
    expect(settledExposure(2)).toBeCloseTo(settledExposure(1), 9);
  });

  it('does not retrade while the target is unchanged', () => {
    // The risk-manager size drifts every bar as equity moves; sizing off that
    // instead of off the last acted-on target churns fees for no decision.
    const rising = Array.from({ length: 200 }, (_, i) =>
      bar(i, 100 + i, 101 + i, 99 + i, 100 + i));
    const result = runBacktest(rising, scripted(new Array(200).fill({ target: 1 })), {
      ...config,
      costs: DEFAULT_COSTS,
    });
    expect(result.trades).toHaveLength(1);
    // One entry plus the end-of-data exit: two fills, not two hundred.
    const roundTrip = result.trades[0]?.fees ?? 0;
    expect(roundTrip).toBeLessThan(result.startingEquity * 0.01);
  });

  it('ignores a target change smaller than the rebalance threshold', () => {
    const script = flat.map((_, i) => ({ target: i < 10 ? 1 : 0.95, stopPrice: 50 }));
    const result = runBacktest(flat, scripted(script), { ...config, costs: DEFAULT_COSTS });
    const before = result.equityCurve[8]?.exposure ?? 0;
    const after = result.equityCurve[25]?.exposure ?? 0;
    expect(after).toBeCloseTo(before, 6);
  });

  it('acts on a target change larger than the rebalance threshold', () => {
    const script = flat.map((_, i) => ({ target: i < 10 ? 1 : 0.5, stopPrice: 50 }));
    const result = runBacktest(flat, scripted(script), { ...config, costs: DEFAULT_COSTS });
    const before = result.equityCurve[8]?.exposure ?? 0;
    const after = result.equityCurve[25]?.exposure ?? 0;
    expect(after).toBeLessThan(before * 0.6);
  });

  it('books a partial reduction without closing the trade', () => {
    const script = flat.map((_, i) => ({ target: i < 10 ? 1 : 0.4, stopPrice: 50 }));
    const result = runBacktest(flat, scripted(script), config);
    // Scaling down is not an exit: still one round trip, closed at end of data.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe('end-of-data');
  });

  it('rolls the entry price forward as a weighted average when adding', () => {
    // Price falls between the two tranches, so the average must land between
    // them. Scaling up after a RISE would instead shrink the position, since
    // the existing holding already exceeds the target notional.
    const dipping = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 99, 100), // entry at 100, half size
      bar(2, 50, 51, 49, 50), // scale up: the add fills at 50
      bar(3, 50, 51, 49, 50),
      bar(4, 50, 51, 49, 50),
    ];
    const result = runBacktest(dipping, scripted([
      { target: 0.5, stopPrice: 10 },
      { target: 1, stopPrice: 10 },
      { target: 1, stopPrice: 10 },
      { target: 1, stopPrice: 10 },
      { target: 1, stopPrice: 10 },
    ]), config);
    const entry = result.trades[0]?.entryPrice ?? 0;
    expect(entry).toBeGreaterThan(50);
    expect(entry).toBeLessThan(100);
  });

  it('keeps cash non-negative while scaling in', () => {
    const result = runBacktest(flat, scripted(flat.map(() => ({ target: 1 }))), {
      ...config,
      costs: DEFAULT_COSTS,
    });
    for (const point of result.equityCurve) expect(point.equity).toBeGreaterThan(0);
  });
});

describe('exchange minimum order size', () => {
  const flat = Array.from({ length: 30 }, (_, i) => bar(i, 100, 101, 99, 100));
  const withMinimum = {
    ...config,
    costs: { ...DEFAULT_COSTS, minOrderNotional: 10 },
    limits: { ...DEFAULT_LIMITS, riskPerTradePct: 1, maxPositionPct: 100 },
  };

  it('refuses a buy the exchange would reject, rather than pretending it filled', () => {
    // 1% risk with a 50% stop sizes a $100 account at ~$2, under the $10 floor.
    const result = runBacktest(flat, scripted(flat.map(() => ({ target: 1, stopPrice: 50 }))), {
      ...withMinimum,
      startingEquity: 100,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.rejectedOrders ?? 0).toBeGreaterThan(0);
    expect(result.endingEquity).toBeCloseTo(100, 6);
  });

  it('lets the same strategy trade once the account clears the floor', () => {
    const result = runBacktest(flat, scripted(flat.map(() => ({ target: 1, stopPrice: 50 }))), {
      ...withMinimum,
      startingEquity: 100_000,
    });
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it('still closes a dust position at the end of the data', () => {
    // Without the end-of-data exemption the run would report no trade at all
    // and the equity curve would never reconcile against the trade list.
    const result = runBacktest(flat, scripted(flat.map(() => ({ target: 1 }))), {
      ...config,
      costs: { ...DEFAULT_COSTS, minOrderNotional: 0.01 },
      startingEquity: 1_000,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe('end-of-data');
  });

  it('leaves normal-sized accounts completely unaffected', () => {
    const script = flat.map(() => ({ target: 1, stopPrice: 90 }));
    const withFloor = runBacktest(flat, scripted(script), { ...config, costs: DEFAULT_COSTS });
    const noFloor = runBacktest(flat, scripted(script), {
      ...config,
      costs: { ...DEFAULT_COSTS, minOrderNotional: 0 },
    });
    expect(withFloor.endingEquity).toBeCloseTo(noFloor.endingEquity, 9);
    expect(withFloor.rejectedOrders ?? 0).toBe(0);
  });
});

describe('minimumViableEquity', () => {
  it('is the exchange minimum divided by the position fraction', () => {
    // 1% risk over a 10% stop distance is a 10% position, so $1 needs $10.
    expect(minimumViableEquity(DEFAULT_COSTS, 1, 100, 10)).toBeCloseTo(10, 6);
  });

  it('rises as the stop widens, because the position shrinks', () => {
    expect(minimumViableEquity(DEFAULT_COSTS, 1, 100, 50))
      .toBeGreaterThan(minimumViableEquity(DEFAULT_COSTS, 1, 100, 10));
  });

  it('falls as risk per trade rises, which is the wrong way to fix a small account', () => {
    expect(minimumViableEquity(DEFAULT_COSTS, 5, 100, 10))
      .toBeLessThan(minimumViableEquity(DEFAULT_COSTS, 1, 100, 10));
  });

  it('is bounded by the position cap when the stop is very tight', () => {
    expect(minimumViableEquity(DEFAULT_COSTS, 1, 50, 0.1)).toBeCloseTo(2, 6);
  });

  it('is zero when the exchange has no minimum', () => {
    expect(minimumViableEquity(FRICTIONLESS, 1, 100, 10)).toBe(0);
  });
});
