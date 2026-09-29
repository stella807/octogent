import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { runBacktest, DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { FRICTIONLESS } from '../src/backtest/costs.ts';
import { BENCHMARK_LIMITS } from '../src/risk/risk-manager.ts';
import { dcaPath, dcaSafety } from '../src/strategy/dca-safety.ts';
import { gridPath, gridRange } from '../src/strategy/grid-range.ts';

const DAY = 86_400_000;

function bar(i: number, close: number, low = close * 0.995, high = close * 1.005): Candle {
  return { time: i * DAY, open: close, high, low, close, volume: 1 };
}

const flatLine = (n: number): (number | null)[] => Array.from({ length: n }, () => 100);
const unitAtr = (n: number): (number | null)[] => Array.from({ length: n }, () => 1);

describe('gridPath', () => {
  const config = { stepAtr: 1, levels: 3, stopLevels: 2 };

  it('buys one level per full step below the anchor', () => {
    const candles = [100, 99.5, 98.9, 97.9, 96.9].map((c, i) => bar(i, c));
    const held = gridPath(candles, flatLine(5), unitAtr(5), config).map((s) => s?.held);
    expect(held).toEqual([0, 0, 1, 2, 3]);
  });

  it('sells a level only after a full step of recovery, not on the first uptick', () => {
    // Down to level 3, a half-step bounce (still holds 3), then a bounce past
    // the level above (sells back to 2).
    const candles = [100, 96.9, 97.5, 98.5].map((c, i) => bar(i, c));
    const held = gridPath(candles, flatLine(4), unitAtr(4), config).map((s) => s?.held);
    expect(held).toEqual([0, 3, 3, 2]);
  });

  it('exits everything when the range breaks and does not re-arm until price recovers', () => {
    // Load up, then crash through the bottom (100 - 5 steps = 95), then drift
    // around well below the average: the grid must stay out.
    const closesSeq = [100, 98.9, 97.9, 96.9, 94, 94.5, 94.2, 100.5, 98.9];
    const candles = closesSeq.map((c, i) => bar(i, c, i === 4 ? 93.5 : c * 0.995));
    const states = gridPath(candles, flatLine(closesSeq.length), unitAtr(closesSeq.length), config);
    expect(states[4]?.held).toBe(0);
    expect(states[4]?.reason).toMatch(/range broke/);
    expect(states[5]?.held).toBe(0);
    expect(states[6]?.held).toBe(0);
    // Back above the average re-arms; a fresh step down buys again.
    expect(states[8]?.held).toBe(1);
  });

  it('rejects level counts the engine could not trade slice by slice', () => {
    expect(() => gridRange.create([], { ...gridRange.defaults, levels: 20 })).toThrow(/levels/);
  });
});

describe('dcaPath', () => {
  const config = { baseSlice: 0.2, maxSafety: 4, stepPct: 5, tpPct: 5, stopSteps: 2, trendPeriod: 0 };

  it('opens with the base order and adds a safety order per step down', () => {
    const candles = [100, 96, 94.9, 89.9, 84.9].map((c, i) => bar(i, c));
    const exposure = dcaPath(candles, null, config).map((s) => s?.exposure);
    expect(exposure[0]).toBeCloseTo(0.2);
    expect(exposure[1]).toBeCloseTo(0.2);
    expect(exposure[2]).toBeCloseTo(0.4);
    expect(exposure[3]).toBeCloseTo(0.6);
    expect(exposure[4]).toBeCloseTo(0.8);
  });

  it('takes profit against the averaged-down cost, below the original entry', () => {
    // Base at 100, one safety at 94.9: average ~97.45, so +5% is ~102.3.
    // A recovery to 101 is still short of that; 102.5 clears it.
    const candles = [100, 94.9, 101, 102.5].map((c, i) => bar(i, c));
    const states = dcaPath(candles, null, config);
    expect(states[2]?.exposure).toBeGreaterThan(0);
    expect(states[3]?.exposure).toBe(0);
    expect(states[3]?.reason).toMatch(/take profit/);
  });

  it('stops out once the decline runs past every safety order', () => {
    // Stop sits at 100 * (1 - 0.05 * (4 + 2)) = 70.
    const closesSeq = [100, 95, 90, 85, 80, 75, 69];
    const candles = closesSeq.map((c, i) => bar(i, c));
    const states = dcaPath(candles, null, config);
    expect(states[4]?.exposure).toBeCloseTo(1);
    expect(states[6]?.exposure).toBe(0);
    expect(states[6]?.reason).toMatch(/stop/);
  });

  it('will not open a new cycle below the trend filter', () => {
    const candles = [90, 90, 90].map((c, i) => bar(i, c));
    const trend = [100, 100, 100];
    const states = dcaPath(candles, trend, { ...config, trendPeriod: 3 });
    expect(states.every((s) => s?.exposure === 0)).toBe(true);
  });

  it('rejects safety orders too small for the engine to place', () => {
    expect(() => dcaSafety.create([], { ...dcaSafety.defaults, maxSafety: 10 })).toThrow(/10%/);
  });
});

describe('DCA tail risk through the engine', () => {
  it('wins most cycles in chop, then one sustained decline dominates the result', () => {
    // Ten gentle dips-and-recoveries, then a 40% slide.
    const seq: number[] = [];
    for (let k = 0; k < 10; k += 1) seq.push(100, 96, 94, 97, 101, 104);
    for (let k = 0; k <= 20; k += 1) seq.push(104 - k * 2.2);
    const candles = seq.map((c, i) => bar(i, c));
    const result = runBacktest(
      candles,
      dcaSafety.create(candles, { ...dcaSafety.defaults, trendPeriod: 0 }),
      { ...DEFAULT_CONFIG, costs: FRICTIONLESS, limits: BENCHMARK_LIMITS },
    );
    const wins = result.trades.filter((t) => t.pnl > 0);
    const losses = result.trades.filter((t) => t.pnl <= 0);
    expect(wins.length).toBeGreaterThan(losses.length);
    const worstLoss = Math.min(...losses.map((t) => t.pnl));
    const avgWin = wins.reduce((a, t) => a + t.pnl, 0) / wins.length;
    expect(-worstLoss).toBeGreaterThan(avgWin * 3);
  });
});
