import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { breakevenHitRate, coinFlip, formatBinary, runBinary, type BinaryOptions, type Call } from '../src/backtest/binary.ts';
import { generateCandles } from '../src/data/synthetic.ts';

const DAY = 86_400_000;
const closes = (values: number[]): Candle[] =>
  values.map((close, i) => ({ time: i * DAY, open: close, high: close, low: close, close, volume: 1 }));

const OPTIONS: BinaryOptions = { expiryBars: 1, payout: 0.8, stakePct: 0.1, minStake: 1, startingEquity: 100 };

describe('breakevenHitRate', () => {
  it('is the win rate at which a fixed-payout bet stops losing money', () => {
    expect(breakevenHitRate(0.8)).toBeCloseTo(1 / 1.8, 12);
    expect(breakevenHitRate(1)).toBe(0.5);
  });
});

describe('runBinary', () => {
  const series = closes([10, 11, 10, 12, 11, 13]);
  const foresight = (t: number): Call => ((series[t + 1]?.close ?? 0) > (series[t]?.close ?? 0) ? 'up' : 'down');

  it('pays stake × payout on a win and takes the whole stake on a loss', () => {
    const win = runBinary(series.slice(0, 2), () => 'up', OPTIONS);
    expect(win.bets).toHaveLength(1);
    expect(win.finalEquity).toBeCloseTo(100 + 10 * 0.8, 9);
    const loss = runBinary(series.slice(0, 2), () => 'down', OPTIONS);
    expect(loss.finalEquity).toBeCloseTo(90, 9);
  });

  it('wins every bet with perfect foresight, and still only earns the payout', () => {
    const r = runBinary(series, foresight, OPTIONS);
    expect(r.wins).toBe(5);
    expect(r.hitRate).toBe(1);
    expect(r.finalEquity).toBeCloseTo(100 * 1.08 ** 5, 9);
  });

  it('refunds a bet when the price ends exactly where it started', () => {
    const r = runBinary(closes([10, 10]), () => 'up', OPTIONS);
    expect(r.pushes).toBe(1);
    expect(r.finalEquity).toBe(100);
  });

  it('never lets bets overlap: the next one opens when the last expires', () => {
    const seen: number[] = [];
    runBinary(closes([1, 2, 3, 4, 5, 6, 7]), (t) => { seen.push(t); return 'up'; }, { ...OPTIONS, expiryBars: 2 });
    expect(seen).toEqual([0, 2, 4]);
  });

  it('skips bars the signal has no call for', () => {
    const r = runBinary(series, (t) => (t === 2 ? 'up' : null), OPTIONS);
    expect(r.bets).toHaveLength(1);
    expect(r.bets[0]?.t).toBe(2);
  });

  it('stops once the account cannot cover the minimum stake', () => {
    const falling = closes(Array.from({ length: 200 }, (_, i) => 1000 - i));
    const r = runBinary(falling, () => 'up', { ...OPTIONS, stakePct: 0.5, startingEquity: 10 });
    expect(r.busted).toBe(true);
    expect(r.finalEquity).toBeLessThan(1);
    expect(r.bets.length).toBeLessThan(199);
    expect(r.barsLasted).toBe(r.bets.length);
  });

  it('loses money guessing at random, because the payout is under even money', () => {
    const candles = generateCandles({ bars: 4000, timeframe: '1d', seed: 7 });
    const r = runBinary(candles, coinFlip(3), { ...OPTIONS, stakePct: 0.01, startingEquity: 1000 });
    expect(r.hitRate).toBeGreaterThan(0.45);
    expect(r.hitRate).toBeLessThan(0.55);
    expect(r.returnPerDollar).toBeLessThan(0);
    expect(r.finalEquity).toBeLessThan(1000);
  });

  it('reports how far the hit rate sits from breakeven in standard errors', () => {
    const r = runBinary(series, foresight, OPTIONS);
    expect(r.tStatVsBreakeven).toBeGreaterThan(0);
    expect(formatBinary([{ label: 'foresight', result: r }], OPTIONS, 'TEST', '1d')).toMatch(/55\.6%/);
  });
});
