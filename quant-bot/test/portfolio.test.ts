import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { DEFAULT_COSTS, FRICTIONLESS } from '../src/backtest/costs.ts';
import { computeMetrics } from '../src/backtest/metrics.ts';
import { BENCHMARK_LIMITS, DEFAULT_LIMITS } from '../src/risk/risk-manager.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import {
  alignCandles,
  alignmentCoverage,
  asBacktestResult,
  crossSectionalMomentum,
  equalWeight,
  getPortfolioStrategy,
  normalise,
  runPortfolioBacktest,
} from '../src/portfolio/index.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function line(closes: number[], startBar = 0): Candle[] {
  return closes.map((close, i) => ({
    time: T0 + (i + startBar) * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1,
  }));
}

const config = { ...DEFAULT_CONFIG, costs: FRICTIONLESS, limits: BENCHMARK_LIMITS };

describe('alignCandles', () => {
  it('keeps only timestamps every symbol has', () => {
    const series = alignCandles(new Map([
      ['A', line([1, 2, 3, 4])],
      ['B', line([10, 20, 30], 1)], // starts a day later
    ]));
    expect(series.times).toHaveLength(3);
    expect(series.times[0]).toBe(T0 + DAY);
  });

  it('never forward-fills a missing bar into a price that never traded', () => {
    const a = line([1, 2, 3]);
    const gapped = [a[0] as Candle, a[2] as Candle]; // day 2 missing
    const series = alignCandles(new Map([['A', a], ['B', gapped]]));
    expect(series.times).toEqual([T0, T0 + 2 * DAY]);
  });

  it('pairs each symbol with the right bar after alignment', () => {
    const series = alignCandles(new Map([
      ['A', line([1, 2, 3])],
      ['B', line([10, 20, 30])],
    ]));
    for (let i = 0; i < series.times.length; i += 1) {
      expect(series.bars[0]?.[i]?.time).toBe(series.times[i]);
      expect(series.bars[1]?.[i]?.time).toBe(series.times[i]);
    }
  });

  it('refuses symbols that share no history rather than returning nothing useful', () => {
    expect(() => alignCandles(new Map([
      ['A', line([1, 2])],
      ['B', line([1, 2], 100)],
    ]))).toThrow(/share no common timestamps/);
  });

  it('rejects an empty universe or an empty symbol', () => {
    expect(() => alignCandles(new Map())).toThrow(RangeError);
    expect(() => alignCandles(new Map([['A', []]]))).toThrow(/no candles for A/);
  });

  it('reports how much of each symbol survived alignment', () => {
    const input = new Map([['A', line([1, 2, 3, 4])], ['B', line([10, 20, 30], 1)]]);
    const coverage = alignmentCoverage(input, alignCandles(input));
    expect(coverage.get('A')).toBeCloseTo(0.75, 6);
    expect(coverage.get('B')).toBeCloseTo(1, 6);
  });
});

describe('normalise', () => {
  it('leaves weights that already fit alone', () => {
    expect(normalise([0.3, 0.3])).toEqual([0.3, 0.3]);
  });

  it('scales down rather than levering up when weights exceed 1', () => {
    const out = normalise([1, 1]);
    expect(out.reduce((a, w) => a + w, 0)).toBeCloseTo(1, 9);
    expect(out[0]).toBeCloseTo(out[1] as number, 9);
  });

  it('treats negatives as flat, since this is spot with no shorting', () => {
    expect(normalise([-1, 0.5])).toEqual([0, 0.5]);
  });

  it('turns NaN into flat rather than poisoning the portfolio', () => {
    expect(normalise([Number.NaN, 0.5])).toEqual([0, 0.5]);
  });
});

/** Weights driven by an explicit script, so fills can be asserted exactly. */
function scriptedWeights(script: readonly (readonly number[])[], warmup = 0) {
  return {
    name: 'scripted',
    params: {},
    warmup,
    weightsAt: (i: number) => script[i] ?? script[script.length - 1] ?? [],
  };
}

describe('portfolio engine', () => {
  const series = alignCandles(new Map([
    ['A', line([100, 100, 200, 200, 200])],
    ['B', line([100, 100, 100, 100, 100])],
  ]));

  it('fills weights from bar i at the open of bar i+1', () => {
    const result = runPortfolioBacktest(series, scriptedWeights([
      [0, 0],
      [0.5, 0.5], // decided at bar 1, filled at bar 2's open
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ]), config);
    expect(result.equityCurve[1]?.exposure).toBe(0);
    expect(result.equityCurve[2]?.exposure).toBeGreaterThan(0.9);
    // A was bought at 200, its bar-2 open, not at its bar-1 close of 100.
    const tradeA = result.trades.find((t) => t.symbol === 'A');
    expect(tradeA?.entryPrice).toBeCloseTo(200, 6);
  });

  it('closes every open holding at the end of the data', () => {
    const result = runPortfolioBacktest(series, scriptedWeights([[0.5, 0.5]]), config);
    expect(result.trades).toHaveLength(2);
    for (const trade of result.trades) expect(trade.exitReason).toBe('end-of-data');
  });

  it('conserves value: ending equity equals start plus the sum of trade P&L', () => {
    const result = runPortfolioBacktest(series, scriptedWeights([[0.5, 0.5]]), {
      ...config,
      costs: DEFAULT_COSTS,
    });
    const totalPnl = result.trades.reduce((a, t) => a + t.pnl, 0);
    expect(result.endingEquity).toBeCloseTo(result.startingEquity + totalPnl, 6);
  });

  it('attributes P&L to the symbol that produced it', () => {
    const result = runPortfolioBacktest(series, scriptedWeights([[0.5, 0.5]]), config);
    const totalPnl = result.trades.reduce((a, t) => a + t.pnl, 0);
    const contributed = Object.values(result.contribution).reduce((a, v) => a + v, 0);
    expect(contributed).toBeCloseTo(totalPnl, 6);
    // A doubled and B did not, so A must carry the gain.
    expect(result.contribution['A'] ?? 0).toBeGreaterThan(result.contribution['B'] ?? 0);
  });

  it('never spends cash it does not have', () => {
    const result = runPortfolioBacktest(series, scriptedWeights([[1, 1]]), {
      ...config,
      costs: DEFAULT_COSTS,
    });
    for (const point of result.equityCurve) expect(point.equity).toBeGreaterThan(0);
    expect(result.equityCurve.at(-1)?.exposure).toBeLessThanOrEqual(1.0001);
  });

  it('ignores weight drift below the rebalance threshold', () => {
    const flat = alignCandles(new Map([
      ['A', line(new Array(20).fill(100))],
      ['B', line(new Array(20).fill(100))],
    ]));
    const script = Array.from({ length: 20 }, (_, i) =>
      (i < 5 ? [0.5, 0.5] : [0.505, 0.495]));
    const result = runPortfolioBacktest(flat, scriptedWeights(script), {
      ...config,
      costs: DEFAULT_COSTS,
    });
    // Two entries and two end-of-data exits; the 0.5-point drift buys nothing.
    expect(result.trades).toHaveLength(2);
  });

  it('liquidates every symbol when the kill switch fires', () => {
    const crashing = alignCandles(new Map([
      ['A', line([100, 100, 100, 40, 40, 40])],
      ['B', line([100, 100, 100, 40, 40, 40])],
    ]));
    const result = runPortfolioBacktest(crashing, scriptedWeights([[0.5, 0.5]]), {
      ...config,
      limits: { ...DEFAULT_LIMITS, maxDrawdownPct: 20 },
    });
    expect(result.firstHalt?.kind).toBe('max-drawdown');
    expect(result.trades.every((t) => t.exitReason === 'risk-halt')).toBe(true);
    expect(result.equityCurve.at(-1)?.exposure).toBe(0);
  });

  it('rejects a non-positive starting equity', () => {
    expect(() => runPortfolioBacktest(series, scriptedWeights([[0.5, 0.5]]), {
      ...config,
      startingEquity: 0,
    })).toThrow(RangeError);
  });

  it('produces metrics through the same path as a single-asset run', () => {
    const result = runPortfolioBacktest(series, scriptedWeights([[0.5, 0.5]]), config);
    const metrics = computeMetrics(asBacktestResult(result));
    expect(metrics.trades).toBe(result.trades.length);
    expect(Number.isNaN(metrics.maxDrawdownPct)).toBe(false);
  });
});

describe('equal-weight', () => {
  it('splits the account evenly and holds', () => {
    const series = alignCandles(new Map([
      ['A', line([1, 2, 3])],
      ['B', line([1, 2, 3])],
      ['C', line([1, 2, 3])],
    ]));
    const weights = equalWeight.create(series, equalWeight.defaults).weightsAt(0);
    expect(weights).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
});

describe('cross-sectional-momentum', () => {
  // A is strongest, B is flat, C falls.
  const bars = 200;
  const series = alignCandles(new Map([
    ['A', line(Array.from({ length: bars }, (_, i) => 100 + i * 2))],
    ['B', line(Array.from({ length: bars }, (_, i) => 100 + i * 0.5))],
    ['C', line(Array.from({ length: bars }, (_, i) => 200 - i * 0.5))],
  ]));

  it('holds the strongest symbols and skips the weakest', () => {
    const strategy = crossSectionalMomentum.create(series, {
      lookback: 30, topK: 2, rebalanceEvery: 7, absoluteFilter: 1,
    });
    const weights = strategy.weightsAt(199);
    expect(weights[0]).toBeGreaterThan(0); // A
    expect(weights[1]).toBeGreaterThan(0); // B
    expect(weights[2]).toBe(0); // C is falling
  });

  it('holds nothing when every symbol is falling', () => {
    const falling = alignCandles(new Map([
      ['A', line(Array.from({ length: bars }, (_, i) => 200 - i * 0.5))],
      ['B', line(Array.from({ length: bars }, (_, i) => 200 - i * 0.4))],
    ]));
    const strategy = crossSectionalMomentum.create(falling, {
      lookback: 30, topK: 2, rebalanceEvery: 7, absoluteFilter: 1,
    });
    expect(strategy.weightsAt(199).every((w) => w === 0)).toBe(true);
  });

  it('without the absolute filter it holds the least-bad faller', () => {
    const falling = alignCandles(new Map([
      ['A', line(Array.from({ length: bars }, (_, i) => 200 - i * 0.5))],
      ['B', line(Array.from({ length: bars }, (_, i) => 200 - i * 0.4))],
    ]));
    const strategy = crossSectionalMomentum.create(falling, {
      lookback: 30, topK: 1, rebalanceEvery: 7, absoluteFilter: 0,
    });
    // Still a position in a falling market: this is what the filter prevents.
    expect(strategy.weightsAt(199).some((w) => w > 0)).toBe(true);
  });

  it('keeps cash when fewer symbols qualify than topK', () => {
    const strategy = crossSectionalMomentum.create(series, {
      lookback: 30, topK: 3, rebalanceEvery: 7, absoluteFilter: 1,
    });
    const weights = strategy.weightsAt(199);
    // Only A and B qualify, each at 1/3: the last third stays in cash rather
    // than concentrating into the survivors.
    expect(weights.reduce((a, w) => a + w, 0)).toBeCloseTo(2 / 3, 6);
  });

  it('never weights above 1 in total', () => {
    const strategy = crossSectionalMomentum.create(series, crossSectionalMomentum.defaults);
    for (let i = 100; i < bars; i += 1) {
      expect(strategy.weightsAt(i).reduce((a, w) => a + w, 0)).toBeLessThanOrEqual(1.0001);
    }
  });

  it('holds its weights steady between scheduled rebalances', () => {
    const strategy = crossSectionalMomentum.create(series, {
      lookback: 30, topK: 2, rebalanceEvery: 10, absoluteFilter: 1,
    });
    const anchor = strategy.weightsAt(150);
    for (let i = 151; i < 160; i += 1) expect(strategy.weightsAt(i)).toEqual(anchor);
  });

  it('cannot see the future', () => {
    const full = crossSectionalMomentum.create(series, crossSectionalMomentum.defaults);
    const truncated = crossSectionalMomentum.create(
      alignCandles(new Map([
        ['A', (series.bars[0] as Candle[]).slice(0, 151)],
        ['B', (series.bars[1] as Candle[]).slice(0, 151)],
        ['C', (series.bars[2] as Candle[]).slice(0, 151)],
      ])),
      crossSectionalMomentum.defaults,
    );
    expect(truncated.weightsAt(150)).toEqual(full.weightsAt(150));
  });

  it('rejects a lookback too short to measure anything', () => {
    expect(() => crossSectionalMomentum.create(series, { lookback: 1 })).toThrow(RangeError);
  });
});

describe('portfolio registry', () => {
  it('resolves by name and lists alternatives otherwise', () => {
    expect(getPortfolioStrategy('equal-weight').name).toBe('equal-weight');
    expect(() => getPortfolioStrategy('nope')).toThrow(/Available: /);
  });
});

describe('diversification actually reduces drawdown', () => {
  it('spreads risk across uncorrelated series better than a single one', () => {
    const universe = new Map<string, Candle[]>();
    for (let s = 0; s < 6; s += 1) {
      universe.set(`S${s}`, generateCandles({ bars: 1200, seed: 100 + s }));
    }
    const series = alignCandles(universe);
    const spread = runPortfolioBacktest(
      series,
      equalWeight.create(series, equalWeight.defaults),
      { ...config, costs: DEFAULT_COSTS },
    );
    const single = runPortfolioBacktest(
      alignCandles(new Map([['S0', universe.get('S0') as Candle[]]])),
      { name: 'one', params: {}, warmup: 0, weightsAt: () => [1] },
      { ...config, costs: DEFAULT_COSTS },
    );
    const spreadDd = computeMetrics(asBacktestResult(spread)).maxDrawdownPct;
    const singleDd = computeMetrics(asBacktestResult(single)).maxDrawdownPct;
    expect(spreadDd).toBeLessThan(singleDd);
  });
});
