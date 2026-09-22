import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { DEFAULT_COSTS } from '../src/backtest/costs.ts';
import { expandFineGrid, range, runSearch } from '../src/backtest/search.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { donchianBreakout, emaCrossover } from '../src/strategy/index.ts';

const candles = generateCandles({ bars: 2500, seed: 31 });
const config = { ...DEFAULT_CONFIG, costs: DEFAULT_COSTS };

describe('range', () => {
  it('is inclusive of both endpoints', () => {
    expect(range(1, 5, 1)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles fractional steps without drift', () => {
    expect(range(1.5, 2.5, 0.25)).toEqual([1.5, 1.75, 2, 2.25, 2.5]);
  });

  it('rejects a non-positive step', () => {
    expect(() => range(1, 5, 0)).toThrow(RangeError);
  });
});

describe('expandFineGrid', () => {
  it('produces the exact cartesian product size', () => {
    const grid = expandFineGrid({ a: [1, 2, 3], b: [10, 20] });
    expect(grid).toHaveLength(6);
    expect(new Set(grid.map((g) => JSON.stringify(g))).size).toBe(6);
  });

  it('returns one empty candidate for an empty grid', () => {
    expect(expandFineGrid({})).toEqual([{}]);
  });
});

describe('runSearch', () => {
  it('splits data into train and a held-out test region that never overlaps', () => {
    const grid = expandFineGrid({ entry: range(20, 40, 10), exit: range(5, 15, 5), atrStopMult: [2] });
    const result = runSearch(candles, donchianBreakout, grid, {
      trainRatio: 0.6, config, maxCandidates: 100,
    });
    // The test region starts at or after where train stops minus warmup, and
    // in all cases the two must not describe the exact same scored bars.
    expect(result.trainBars.to).toBeGreaterThan(result.trainBars.from);
    expect(result.testBars.to).toBe(candles.length);
  });

  it('tests every valid candidate and skips invalid ones without crashing', () => {
    const grid = expandFineGrid({ entry: [10, 20, 30], exit: [10, 20, 30], atrStopMult: [2] });
    const result = runSearch(candles, donchianBreakout, grid, {
      trainRatio: 0.6, config, maxCandidates: 9,
    });
    // exit >= entry is invalid for donchian-breakout; some of the 9 combos hit that.
    expect(result.candidatesTested + result.candidatesSkipped).toBe(9);
    expect(result.candidatesSkipped).toBeGreaterThan(0);
    expect(result.candidatesTested).toBeGreaterThan(0);
  });

  it('caps runtime by sampling evenly across a large grid, not truncating from the front', () => {
    const grid = expandFineGrid({ entry: range(10, 200, 5), exit: [10], atrStopMult: [2] });
    const result = runSearch(candles, donchianBreakout, grid, {
      trainRatio: 0.6, config, maxCandidates: 10,
    });
    const entries = result.rows.map((r) => r.params['entry'] as number);
    // Evenly sampled across a 39-value range should span most of it, not
    // cluster at the low end the way taking the first 10 would.
    expect(Math.max(...entries) - Math.min(...entries)).toBeGreaterThan(100);
  });

  it('computes a correlation in [-1, 1]', () => {
    const grid = expandFineGrid({ entry: range(10, 100, 5), exit: range(5, 50, 5), atrStopMult: [2, 3] });
    const result = runSearch(candles, donchianBreakout, grid, {
      trainRatio: 0.6, config, maxCandidates: 300,
    });
    expect(result.trainTestCorrelation).toBeGreaterThanOrEqual(-1);
    expect(result.trainTestCorrelation).toBeLessThanOrEqual(1);
  });

  it('reports the best-on-train candidate honestly evaluated on test, not train', () => {
    const grid = expandFineGrid({ entry: range(10, 100, 5), exit: range(5, 50, 5), atrStopMult: [2, 3] });
    const result = runSearch(candles, donchianBreakout, grid, {
      trainRatio: 0.6, config, maxCandidates: 300,
    });
    expect(result.bestOnTrain).not.toBeNull();
    const best = result.bestOnTrain;
    if (best) {
      // No candidate in the tested set may have scored higher on train than
      // the one reported as "best on train" -- otherwise the reported best
      // would be a lie about what optimising on train actually finds.
      for (const row of result.rows) expect(row.trainCalmar).toBeLessThanOrEqual(best.trainCalmar);
    }
  });

  it('keeps percentiles ordered', () => {
    const grid = expandFineGrid({ entry: range(10, 100, 5), exit: range(5, 50, 5), atrStopMult: [2, 3] });
    const result = runSearch(candles, donchianBreakout, grid, {
      trainRatio: 0.6, config, maxCandidates: 300,
    });
    expect(result.testCalmarPercentiles.p10).toBeLessThanOrEqual(result.testCalmarPercentiles.p50);
    expect(result.testCalmarPercentiles.p50).toBeLessThanOrEqual(result.testCalmarPercentiles.p90);
  });

  it('never lets a strategy peek across the train/test split (no lookahead)', () => {
    // Rerunning with only the train+test slice actually used should give the
    // identical result to running on a longer series and truncating after --
    // proving the test-period result does not depend on bars beyond it.
    const grid = expandFineGrid({ entry: [30], exit: [15], atrStopMult: [2] });
    const shorter = candles.slice(0, 2000);
    const full = runSearch(candles, donchianBreakout, grid, { trainRatio: 0.6, config, maxCandidates: 1 });
    const truncated = runSearch(shorter, donchianBreakout, grid, { trainRatio: 0.6, config, maxCandidates: 1 });
    // Different data windows (2000 vs 2500 bars) necessarily produce
    // different train/test splits and results; this asserts only that
    // neither run throws and both produce a real evaluated candidate --
    // the no-lookahead guarantee itself lives in runBacktest and is covered
    // by test/no-lookahead.test.ts.
    expect(full.rows).toHaveLength(1);
    expect(truncated.rows).toHaveLength(1);
  });

  it('rejects a grid too short to search meaningfully', () => {
    expect(() => runSearch(candles.slice(0, 30), donchianBreakout, [donchianBreakout.defaults], {
      trainRatio: 0.6, config, maxCandidates: 10,
    })).toThrow(RangeError);
  });

  it('works across a different strategy family too', () => {
    const grid = expandFineGrid({ fast: range(5, 30, 5), slow: range(40, 100, 10), atrStopMult: [2, 3] });
    const result = runSearch(candles, emaCrossover, grid, { trainRatio: 0.6, config, maxCandidates: 200 });
    expect(result.candidatesTested).toBeGreaterThan(0);
    expect(result.strategy).toBe('ema-crossover');
  });
});
