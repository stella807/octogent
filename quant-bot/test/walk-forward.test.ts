import { describe, expect, it } from 'vitest';
import { generateCandles } from '../src/data/synthetic.ts';
import { DEFAULT_WF_OPTIONS, expandGrid, walkForward } from '../src/backtest/walk-forward.ts';
import { emaCrossover, donchianBreakout } from '../src/strategy/index.ts';

const candles = generateCandles({ bars: 3000, seed: 11 });

describe('fold geometry', () => {
  const result = walkForward(candles, emaCrossover, { ...DEFAULT_WF_OPTIONS, folds: 4 });

  it('scores every fold on bars that come after its training window', () => {
    for (const fold of result.folds) {
      expect(fold.outOfSample.from).toBeGreaterThanOrEqual(fold.inSample.to);
    }
  });

  it('tiles the out-of-sample windows contiguously, leaving no untested gaps', () => {
    for (let i = 1; i < result.folds.length; i += 1) {
      expect(result.folds[i]?.outOfSample.from).toBe(result.folds[i - 1]?.outOfSample.to);
    }
  });

  it('tests all the way to the end of the data', () => {
    expect(result.folds[result.folds.length - 1]?.outOfSample.to).toBe(candles.length);
  });

  it('produces one fold per requested fold', () => {
    expect(result.folds).toHaveLength(4);
  });
});

describe('no optimiser leakage', () => {
  it('gives identical results whether or not future bars exist beyond the last fold', () => {
    // Truncating after the final out-of-sample bar must not change any fold,
    // which it would if the optimiser were reaching forward.
    const full = walkForward(candles, emaCrossover, { ...DEFAULT_WF_OPTIONS, folds: 3 });
    const lastOos = full.folds[full.folds.length - 1]?.outOfSample.to ?? candles.length;
    const truncated = walkForward(candles.slice(0, lastOos), emaCrossover, {
      ...DEFAULT_WF_OPTIONS,
      folds: 3,
    });
    expect(truncated.folds.map((f) => f.chosenParams))
      .toEqual(full.folds.map((f) => f.chosenParams));
  });

  it('is deterministic across runs', () => {
    const a = walkForward(candles, donchianBreakout, DEFAULT_WF_OPTIONS);
    const b = walkForward(candles, donchianBreakout, DEFAULT_WF_OPTIONS);
    expect(a.outOfSampleMetrics).toEqual(b.outOfSampleMetrics);
  });
});

describe('efficiency', () => {
  it('stays finite even when a fold has too few trades to score', () => {
    const result = walkForward(candles, emaCrossover, { ...DEFAULT_WF_OPTIONS, folds: 8 });
    expect(Number.isFinite(result.efficiency)).toBe(true);
  });
});

describe('guardrails', () => {
  it('refuses to split history too thin to mean anything', () => {
    expect(() => walkForward(generateCandles({ bars: 120 }), emaCrossover, DEFAULT_WF_OPTIONS))
      .toThrow(RangeError);
  });

  it('rejects an in-sample ratio outside (0, 1)', () => {
    expect(() => walkForward(candles, emaCrossover, { ...DEFAULT_WF_OPTIONS, inSampleRatio: 1 }))
      .toThrow(RangeError);
  });
});

describe('expandGrid', () => {
  it('produces the full cartesian product over the defaults', () => {
    const combos = expandGrid(emaCrossover);
    const grid = emaCrossover.grid;
    const expected = Object.values(grid).reduce((acc, values) => acc * values.length, 1);
    expect(combos).toHaveLength(expected);
    for (const combo of combos) expect(combo['atrPeriod']).toBe(emaCrossover.defaults['atrPeriod']);
  });

  it('returns just the defaults for a strategy with no parameters', () => {
    expect(expandGrid({ name: 'x', defaults: { a: 1 }, grid: {}, create: () => {
      throw new Error('unused');
    } })).toEqual([{ a: 1 }]);
  });
});
