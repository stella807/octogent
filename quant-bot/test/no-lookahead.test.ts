import { describe, expect, it } from 'vitest';
import { generateCandles } from '../src/data/synthetic.ts';
import { runBacktest } from '../src/backtest/engine.ts';
import { DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { STRATEGIES } from '../src/strategy/index.ts';
import type { Position } from '../src/domain/types.ts';
import type { Params, StrategyFactory } from '../src/strategy/types.ts';

const candles = generateCandles({ bars: 2500, seed: 7 });

/**
 * Synthetic data is geometric Brownian motion, which by construction has no
 * mean reversion to find, so the textbook RSI settings almost never fire on
 * it. Loosening them here keeps this test exercising real signals rather than
 * passing vacuously on an empty trade list.
 */
const TEST_PARAMS: Readonly<Record<string, Params>> = {
  'rsi-mean-reversion': { rsiPeriod: 7, entryLevel: 42, exitLevel: 55, trendPeriod: 50, atrStopMult: 3 },
};

const paramsFor = (factory: StrategyFactory): Params => ({
  ...factory.defaults,
  ...(TEST_PARAMS[factory.name] ?? {}),
});

const openPosition: Position = {
  qty: 0.1,
  entryPrice: 100,
  entryTime: 0,
  stopPrice: 90,
  highWaterPrice: 110,
  realizedPnl: 0,
  feesPaid: 0,
  peakQty: 0.1,
  equityAtEntry: 10_000,
};

/**
 * The property that makes every other number in this repo meaningful: a
 * strategy asked about bar `i` must give the same answer whether or not bars
 * after `i` exist. Anything that fails here is reading the future, and its
 * backtest is fiction.
 */
describe('strategies cannot see the future', () => {
  for (const factory of Object.values(STRATEGIES)) {
    it(`${factory.name} decides bar i identically on truncated and full history`, () => {
      const params = paramsFor(factory);
      const full = factory.create(candles, params);
      for (const i of [300, 700, 1401, 2255]) {
        const prefix = factory.create(candles.slice(0, i + 1), params);
        for (const position of [null, openPosition]) {
          expect(prefix.signalAt(i, position), `bar ${i}`)
            .toEqual(full.signalAt(i, position));
        }
      }
    });
  }
});

describe('the engine cannot see the future', () => {
  for (const factory of Object.values(STRATEGIES)) {
    it(`${factory.name} produces a trade history that is a prefix of the longer run`, () => {
      const cut = 1800;
      const params = paramsFor(factory);
      const slice = candles.slice(0, cut);
      const short = runBacktest(slice, factory.create(slice, params), DEFAULT_CONFIG);
      const long = runBacktest(candles, factory.create(candles, params), DEFAULT_CONFIG);

      // The short run force-closes its final position at the cut, so compare
      // only trades that had already closed before the boundary.
      const boundary = candles[cut - 1]?.time ?? 0;
      const shortClosed = short.trades.filter(
        (t) => t.exitTime < boundary && t.exitReason !== 'end-of-data',
      );
      const longClosed = long.trades.filter((t) => t.exitTime < boundary);
      expect(shortClosed).toEqual(longClosed.slice(0, shortClosed.length));
      expect(shortClosed.length).toBeGreaterThan(0);
    });
  }

  it('equity up to the cut is identical in both runs', () => {
    const cut = 1800;
    const factory = STRATEGIES['donchian-breakout'];
    if (!factory) throw new Error('missing strategy');
    const slice = candles.slice(0, cut);
    const short = runBacktest(slice, factory.create(slice, factory.defaults), DEFAULT_CONFIG);
    const long = runBacktest(candles, factory.create(candles, factory.defaults), DEFAULT_CONFIG);
    for (let i = 0; i < cut - 1; i += 1) {
      expect(short.equityCurve[i]?.equity).toBeCloseTo(long.equityCurve[i]?.equity ?? NaN, 8);
    }
  });
});
