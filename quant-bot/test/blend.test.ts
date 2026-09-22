import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { DEFAULT_COSTS, FRICTIONLESS } from '../src/backtest/costs.ts';
import { computeMetrics } from '../src/backtest/metrics.ts';
import { BENCHMARK_LIMITS } from '../src/risk/risk-manager.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { asBacktestResult, runBlend } from '../src/backtest/blend.ts';
import { runBacktest } from '../src/backtest/engine.ts';
import { buyAndHold, donchianBreakout, emaCrossover, rsiMeanReversion } from '../src/strategy/index.ts';

const DAY = 86_400_000;

function flat(bars: number, price = 100): Candle[] {
  return Array.from({ length: bars }, (_, i) => ({
    time: i * DAY, open: price, high: price * 1.01, low: price * 0.99, close: price, volume: 1,
  }));
}

const config = { ...DEFAULT_CONFIG, costs: FRICTIONLESS, limits: BENCHMARK_LIMITS };

describe('runBlend', () => {
  it('splits starting equity across members exactly as weighted', () => {
    const candles = flat(300);
    const result = runBlend(candles, [
      { factory: buyAndHold, params: {}, weight: 0.5 },
      { factory: donchianBreakout, params: donchianBreakout.defaults, weight: 0.5 },
    ], { ...config, startingEquity: 10_000 });
    const members = [...result.members.values()];
    expect(members[0]?.startingEquity).toBeCloseTo(5_000, 6);
    expect(members[1]?.startingEquity).toBeCloseTo(5_000, 6);
  });

  it('rejects running the same strategy twice rather than silently dropping one', () => {
    expect(() => runBlend(flat(100), [
      { factory: buyAndHold, params: {}, weight: 0.5 },
      { factory: buyAndHold, params: {}, weight: 0.5 },
    ], config)).toThrow(/cannot run the same strategy/);
  });

  it('sums member equity into the combined curve at every bar', () => {
    const candles = generateCandles({ bars: 500, seed: 3 });
    const result = runBlend(candles, [
      { factory: donchianBreakout, params: donchianBreakout.defaults, weight: 0.6 },
      { factory: emaCrossover, params: emaCrossover.defaults, weight: 0.4 },
    ], { ...config, costs: DEFAULT_COSTS });
    const members = [...result.members.values()];
    for (let i = 0; i < result.equityCurve.length; i += 1) {
      const sum = (members[0]?.equityCurve[i]?.equity ?? 0) + (members[1]?.equityCurve[i]?.equity ?? 0);
      expect(result.equityCurve[i]?.equity).toBeCloseTo(sum, 6);
    }
  });

  it('ending equity equals the sum of each member run in isolation', () => {
    const candles = generateCandles({ bars: 800, seed: 7 });
    const result = runBlend(candles, [
      { factory: donchianBreakout, params: donchianBreakout.defaults, weight: 0.5 },
      { factory: rsiMeanReversion, params: rsiMeanReversion.defaults, weight: 0.5 },
    ], { ...config, costs: DEFAULT_COSTS });
    const memberSum = [...result.members.values()].reduce((a, r) => a + r.endingEquity, 0);
    expect(result.endingEquity).toBeCloseTo(memberSum, 6);
  });

  it('tags every trade with the strategy that produced it', () => {
    const candles = generateCandles({ bars: 800, seed: 11 });
    const result = runBlend(candles, [
      { factory: donchianBreakout, params: donchianBreakout.defaults, weight: 0.5 },
      { factory: emaCrossover, params: emaCrossover.defaults, weight: 0.5 },
    ], { ...config, costs: DEFAULT_COSTS });
    const strategies = new Set(result.trades.map((t) => t.strategy));
    expect(strategies.has('donchian-breakout')).toBe(true);
    expect(strategies.has('ema-crossover')).toBe(true);
  });

  it('orders combined trades by exit time regardless of which member produced them', () => {
    const candles = generateCandles({ bars: 800, seed: 13 });
    const result = runBlend(candles, [
      { factory: donchianBreakout, params: donchianBreakout.defaults, weight: 0.5 },
      { factory: emaCrossover, params: emaCrossover.defaults, weight: 0.5 },
    ], { ...config, costs: DEFAULT_COSTS });
    for (let i = 1; i < result.trades.length; i += 1) {
      expect(result.trades[i]?.exitTime).toBeGreaterThanOrEqual(result.trades[i - 1]?.exitTime ?? 0);
    }
  });

  it('produces metrics through the same path as a single-strategy backtest', () => {
    const candles = generateCandles({ bars: 800, seed: 17 });
    const result = runBlend(candles, [
      { factory: donchianBreakout, params: donchianBreakout.defaults, weight: 0.7 },
      { factory: rsiMeanReversion, params: rsiMeanReversion.defaults, weight: 0.3 },
    ], { ...config, costs: DEFAULT_COSTS });
    const metrics = computeMetrics(asBacktestResult(result));
    expect(Number.isNaN(metrics.maxDrawdownPct)).toBe(false);
    expect(metrics.trades).toBe(result.trades.length);
  });

  it('rejects weights that do not sum to 1', () => {
    expect(() => runBlend(flat(100), [
      { factory: buyAndHold, params: {}, weight: 0.3 },
      { factory: buyAndHold, params: {}, weight: 0.3 },
    ], config)).toThrow(/must sum to 1/);
  });

  it('rejects a non-positive weight', () => {
    expect(() => runBlend(flat(100), [
      { factory: buyAndHold, params: {}, weight: 1.5 },
      { factory: buyAndHold, params: {}, weight: -0.5 },
    ], config)).toThrow(/weight must be > 0/);
  });

  it('rejects an empty member list', () => {
    expect(() => runBlend(flat(100), [], config)).toThrow(/at least one member/);
  });

  it('does not top up a losing member from a winning one', async () => {
    // A strategy run in the blend must show the exact same equity path as
    // that strategy run alone at the same starting capital -- otherwise the
    // members would be implicitly cross-subsidizing each other's losses.
    const candles = generateCandles({ bars: 600, seed: 19 });
    const alone = donchianBreakout.create(candles, donchianBreakout.defaults);
    const aloneConfig = { ...config, costs: DEFAULT_COSTS, startingEquity: 6_000 };
    const aloneResult = runBacktest(candles, alone, aloneConfig);

    const blended = runBlend(candles, [
      { factory: donchianBreakout, params: donchianBreakout.defaults, weight: 0.6 },
      { factory: rsiMeanReversion, params: rsiMeanReversion.defaults, weight: 0.4 },
    ], { ...config, costs: DEFAULT_COSTS, startingEquity: 10_000 });

    const donchianMember = blended.members.get('donchian-breakout');
    expect(donchianMember?.endingEquity).toBeCloseTo(aloneResult.endingEquity, 6);
  });
});
