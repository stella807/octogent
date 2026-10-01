import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { DEFAULT_WF_OPTIONS } from '../src/backtest/walk-forward.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { fixedParams, flowEdge, rotate } from '../src/research/flow-test.ts';
import { STRATEGIES } from '../src/strategy/index.ts';

describe('rotate', () => {
  it('moves a series around the end without losing or reordering values', () => {
    expect(rotate([1, 2, 3, 4, 5], 2)).toEqual([4, 5, 1, 2, 3]);
    expect(rotate([1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(rotate([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });
});

describe('fixedParams', () => {
  it('pins a strategy to its own defaults so the walk-forward cannot re-tune it', () => {
    const f = fixedParams(STRATEGIES['trend-hold-whales']!, { flowDays: 3 });
    expect(f.defaults['flowDays']).toBe(3);
    expect(f.grid).toEqual({});
  });
});

describe('flowEdge', () => {
  const candles = generateCandles({ bars: 1500, timeframe: '1d', seed: 11 });
  const flow = candles.map((_, i) => (i % 7 < 3 ? 1e6 : -1e6));
  const options = { ...DEFAULT_WF_OPTIONS, config: { ...DEFAULT_CONFIG, startingEquity: 1000, timeframe: '1d' as const } };

  it('compares the filtered strategy to the plain one and to the same filter on time-shifted flows', () => {
    const r = flowEdge('TEST/USD', candles, flow, options, { flowDays: 7 }, 12);
    expect(r.shifted).toHaveLength(12);
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeLessThanOrEqual(1);
    expect(Number.isFinite(r.plain)).toBe(true);
    expect(Number.isFinite(r.real)).toBe(true);
  });

  it('never uses a shift small enough to leave the flows lined up with the prices', () => {
    const r = flowEdge('TEST/USD', candles, flow, options, { flowDays: 7 }, 12);
    for (const s of r.offsets) {
      expect(s).toBeGreaterThanOrEqual(90);
      expect(s).toBeLessThanOrEqual(candles.length - 90);
    }
  });

  it('is deterministic', () => {
    expect(flowEdge('TEST/USD', candles, flow, options, { flowDays: 7 }, 6))
      .toEqual(flowEdge('TEST/USD', candles, flow, options, { flowDays: 7 }, 6));
  });
});
