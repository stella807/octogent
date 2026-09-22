import { describe, expect, it } from 'vitest';
import type { Trade } from '../src/domain/types.ts';
import { DEFAULT_MC_OPTIONS, monteCarlo, mulberry32, quantile } from '../src/backtest/monte-carlo.ts';

const trade = (returnOnEquity: number): Trade => ({
  entryTime: 0,
  exitTime: 1,
  entryPrice: 100,
  exitPrice: 100,
  qty: 1,
  pnl: returnOnEquity * 10_000,
  pnlPct: returnOnEquity * 10,
  equityAtEntry: 10_000,
  returnOnEquity,
  fees: 0,
  exitReason: 'signal',
  barsHeld: 1,
});

const options = { ...DEFAULT_MC_OPTIONS, runs: 500 };

describe('monteCarlo', () => {
  it('is reproducible for a given seed', () => {
    const trades = [trade(0.02), trade(-0.01), trade(0.03), trade(-0.02)];
    const a = monteCarlo(trades, 10_000, options);
    const b = monteCarlo(trades, 10_000, options);
    expect(a).toEqual(b);
  });

  it('gives a different answer for a different seed', () => {
    const trades = [trade(0.02), trade(-0.01), trade(0.03), trade(-0.02)];
    const a = monteCarlo(trades, 10_000, options);
    const b = monteCarlo(trades, 10_000, { ...options, seed: 999 });
    expect(a.finalEquity.median).not.toBe(b.finalEquity.median);
  });

  it('never reports a zero probability of loss for a strategy that has losers', () => {
    const trades = [trade(0.05), trade(-0.04), trade(0.03), trade(-0.06), trade(0.02)];
    const result = monteCarlo(trades, 10_000, options);
    expect(result.probabilityOfLoss).toBeGreaterThan(0);
    expect(result.probabilityOfLoss).toBeLessThan(1);
  });

  it('reports a wide spread when the trades are volatile', () => {
    const calm = monteCarlo([trade(0.01), trade(-0.008)], 10_000, options);
    const wild = monteCarlo([trade(0.4), trade(-0.3)], 10_000, options);
    const spread = (r: { finalEquity: { p95: number; p5: number } }) =>
      r.finalEquity.p95 - r.finalEquity.p5;
    expect(spread(wild)).toBeGreaterThan(spread(calm));
  });

  it('compounds returns on equity, so position size bounds the drawdown', () => {
    // Every trade risks 1% of equity; no resampled ordering can produce ruin.
    const small = Array.from({ length: 40 }, (_, i) => trade(i % 2 === 0 ? 0.01 : -0.01));
    const result = monteCarlo(small, 10_000, options);
    expect(result.maxDrawdownPct.worst).toBeLessThan(50);
    expect(result.probabilityOfRuin).toBe(0);
  });

  it('shows ruin as likely when each trade bets most of the account', () => {
    const reckless = Array.from({ length: 30 }, (_, i) => trade(i % 2 === 0 ? 0.6 : -0.5));
    const result = monteCarlo(reckless, 10_000, options);
    expect(result.probabilityOfRuin).toBeGreaterThan(0.5);
  });

  it('keeps every percentile ordered', () => {
    const trades = [trade(0.05), trade(-0.04), trade(0.03), trade(-0.06)];
    const { finalEquity, maxDrawdownPct } = monteCarlo(trades, 10_000, options);
    expect(finalEquity.p5).toBeLessThanOrEqual(finalEquity.median);
    expect(finalEquity.median).toBeLessThanOrEqual(finalEquity.p95);
    expect(finalEquity.worst).toBeLessThanOrEqual(finalEquity.p5);
    expect(maxDrawdownPct.p5).toBeLessThanOrEqual(maxDrawdownPct.p95);
  });

  it('refuses to resample a sample too small to resample', () => {
    expect(() => monteCarlo([trade(0.01)], 10_000, options)).toThrow(RangeError);
  });
});

describe('quantile', () => {
  it('interpolates between neighbours', () => {
    expect(quantile([0, 10], 0.5)).toBeCloseTo(5, 9);
    expect(quantile([0, 10, 20, 30], 0)).toBe(0);
    expect(quantile([0, 10, 20, 30], 1)).toBe(30);
  });
});

describe('mulberry32', () => {
  it('produces a uniform-looking stream in [0, 1)', () => {
    const random = mulberry32(1);
    let sum = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      sum += value;
    }
    expect(sum / 20_000).toBeCloseTo(0.5, 1);
  });
});
