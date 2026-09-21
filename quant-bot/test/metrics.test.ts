import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/domain/types.ts';
import { computeMetrics, drawdown, maxLosingStreak } from '../src/backtest/metrics.ts';
import { DEFAULT_CONFIG, type BacktestResult } from '../src/backtest/engine.ts';
import { FRICTIONLESS } from '../src/backtest/costs.ts';

const curve = (values: number[]): EquityPoint[] =>
  values.map((equity, i) => ({ time: i * 86_400_000, equity, exposure: 1 }));

const trade = (pnl: number, equityAtEntry = 10_000): Trade => ({
  entryTime: 0,
  exitTime: 86_400_000,
  entryPrice: 100,
  exitPrice: 100 + pnl,
  qty: 1,
  pnl,
  pnlPct: pnl / 100,
  equityAtEntry,
  returnOnEquity: pnl / equityAtEntry,
  fees: 0,
  exitReason: 'signal',
  barsHeld: 1,
});

const resultOf = (values: number[], trades: Trade[]): BacktestResult => ({
  strategy: { name: 'test', params: {} },
  config: { ...DEFAULT_CONFIG, costs: FRICTIONLESS },
  equityCurve: curve(values),
  trades,
  startingEquity: values[0] ?? 0,
  endingEquity: values[values.length - 1] ?? 0,
  firstHalt: null,
  barsTested: values.length,
});

describe('drawdown', () => {
  it('measures peak to trough, not start to trough', () => {
    const { maxDrawdownPct } = drawdown(curve([100, 200, 150, 250]));
    expect(maxDrawdownPct).toBeCloseTo(25, 9);
  });

  it('is zero for a monotonically rising curve', () => {
    expect(drawdown(curve([1, 2, 3, 4])).maxDrawdownPct).toBe(0);
  });

  it('counts how long the account stayed underwater', () => {
    const { maxDrawdownDurationBars } = drawdown(curve([100, 90, 85, 95, 99, 101]));
    expect(maxDrawdownDurationBars).toBe(4);
  });
});

describe('losing streaks', () => {
  it('counts the longest consecutive run, not the total', () => {
    expect(maxLosingStreak([trade(-1), trade(-1), trade(5), trade(-1), trade(-1), trade(-1)]))
      .toBe(3);
  });

  it('treats a scratch trade as a loss, since it still paid fees', () => {
    expect(maxLosingStreak([trade(0), trade(0)])).toBe(2);
  });
});

describe('computeMetrics', () => {
  it('reports the loss rate as the complement of the win rate', () => {
    const m = computeMetrics(resultOf([10_000, 10_500], [trade(100), trade(-50), trade(-50)]));
    expect(m.winRatePct).toBeCloseTo(33.33, 1);
    expect(m.lossRatePct).toBeCloseTo(66.67, 1);
    expect(m.winRatePct + m.lossRatePct).toBeCloseTo(100, 9);
  });

  it('computes profit factor as gross win over gross loss', () => {
    const m = computeMetrics(resultOf([10_000, 10_100], [trade(200), trade(-100)]));
    expect(m.profitFactor).toBeCloseTo(2, 9);
  });

  it('reports an infinite profit factor when nothing lost, rather than hiding it', () => {
    const m = computeMetrics(resultOf([10_000, 10_200], [trade(100), trade(100)]));
    // The report is responsible for explaining that this means "sample too small".
    expect(m.profitFactor).toBe(Infinity);
    expect(m.lossRatePct).toBe(0);
  });

  it('keeps expectancy negative when the average loss outweighs the average win', () => {
    const m = computeMetrics(resultOf([10_000, 9_800], [trade(50), trade(50), trade(-300)]));
    expect(m.expectancy).toBeLessThan(0);
    expect(m.winRatePct).toBeCloseTo(66.67, 1);
  });

  it('records the largest single loss as a negative number', () => {
    const m = computeMetrics(resultOf([10_000, 9_000], [trade(-100), trade(-900)]));
    expect(m.largestLoss).toBeCloseTo(-900, 9);
  });

  it('annualises Sharpe by the timeframe, so 1d and 1h are not compared unscaled', () => {
    const values = [10_000, 10_100, 10_050, 10_200, 10_150, 10_300];
    const daily = computeMetrics({ ...resultOf(values, []), config: { ...DEFAULT_CONFIG, timeframe: '1d' } });
    const hourly = computeMetrics({ ...resultOf(values, []), config: { ...DEFAULT_CONFIG, timeframe: '1h' } });
    expect(Math.abs(hourly.sharpe)).toBeGreaterThan(Math.abs(daily.sharpe));
  });

  it('handles an empty run without producing NaN', () => {
    const m = computeMetrics(resultOf([10_000], []));
    for (const value of Object.values(m)) expect(Number.isNaN(value)).toBe(false);
  });
});
