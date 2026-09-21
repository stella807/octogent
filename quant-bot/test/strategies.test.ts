import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import {
  donchianBreakout,
  emaCrossover,
  getStrategy,
  rsiMeanReversion,
  STRATEGIES,
  takeProfitScalp,
} from '../src/strategy/index.ts';
import { DEFAULT_CONFIG, runBacktest } from '../src/backtest/engine.ts';
import { DEFAULT_COSTS } from '../src/backtest/costs.ts';
import { computeMetrics } from '../src/backtest/metrics.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { formatBacktest } from '../src/report.ts';

const HOUR = 3_600_000;

function ramp(values: number[]): Candle[] {
  return values.map((close, i) => ({
    time: i * HOUR,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1,
  }));
}

const held = (stopPrice?: number): Position => ({
  qty: 1,
  entryPrice: 100,
  entryTime: 0,
  stopPrice,
  highWaterPrice: 120,
  realizedPnl: 0,
  feesPaid: 0,
  peakQty: 1,
  equityAtEntry: 10_000,
});

describe('registry', () => {
  it('resolves every registered strategy by name', () => {
    for (const name of Object.keys(STRATEGIES)) expect(getStrategy(name).name).toBe(name);
  });

  it('lists the alternatives when asked for one that does not exist', () => {
    expect(() => getStrategy('moon-signal')).toThrow(/Available: /);
  });
});

describe('ema-crossover', () => {
  const rising = ramp(Array.from({ length: 300 }, (_, i) => 100 + i));
  const falling = ramp(Array.from({ length: 300 }, (_, i) => 400 - i));

  it('is long while the fast line leads', () => {
    const strategy = emaCrossover.create(rising, emaCrossover.defaults);
    expect(strategy.signalAt(299, null).target).toBe(1);
  });

  it('is flat while the fast line lags', () => {
    const strategy = emaCrossover.create(falling, emaCrossover.defaults);
    expect(strategy.signalAt(299, null).target).toBe(0);
  });

  it('places the stop below the current close', () => {
    const strategy = emaCrossover.create(rising, emaCrossover.defaults);
    const signal = strategy.signalAt(299, null);
    expect(signal.stopPrice).toBeLessThan(rising[299]?.close ?? 0);
  });

  it('never lowers an existing stop', () => {
    const strategy = emaCrossover.create(rising, emaCrossover.defaults);
    const high = (rising[299]?.close ?? 0) - 1;
    expect(strategy.signalAt(299, held(high)).stopPrice).toBe(high);
  });

  it('is flat during warmup rather than guessing', () => {
    const strategy = emaCrossover.create(rising, emaCrossover.defaults);
    expect(strategy.signalAt(3, null).target).toBe(0);
  });

  it('rejects a fast period at or above the slow period', () => {
    expect(() => emaCrossover.create(rising, { fast: 60, slow: 60 })).toThrow(/fast < slow/);
  });
});

describe('donchian-breakout', () => {
  it('enters only on a close above the prior channel high', () => {
    const flat = new Array(200).fill(100);
    const breakout = ramp([...flat, 130]);
    const strategy = donchianBreakout.create(breakout, donchianBreakout.defaults);
    expect(strategy.signalAt(199, null).target).toBe(0);
    expect(strategy.signalAt(200, null).target).toBe(1);
  });

  it('does not treat a bar breaking its own channel as a breakout', () => {
    // A steadily rising series makes every bar its own high; using the
    // unshifted channel would report a breakout on every single bar.
    const rising = ramp(Array.from({ length: 200 }, (_, i) => 100 + i * 0.01));
    const strategy = donchianBreakout.create(rising, { entry: 20, exit: 10, atrPeriod: 14, atrStopMult: 2 });
    const signal = strategy.signalAt(199, null);
    expect(signal.reason).toMatch(/broke 20-bar high/);
    expect(signal.stopPrice).toBeLessThan(rising[199]?.close ?? 0);
  });

  it('exits when price breaks the shorter channel low', () => {
    const series = ramp([...Array.from({ length: 200 }, (_, i) => 100 + i), ...new Array(30).fill(150)]);
    const strategy = donchianBreakout.create(series, donchianBreakout.defaults);
    expect(strategy.signalAt(229, held()).target).toBe(1);

    const dropped = ramp([...Array.from({ length: 200 }, (_, i) => 100 + i), ...new Array(30).fill(150), 100]);
    const after = donchianBreakout.create(dropped, donchianBreakout.defaults);
    expect(after.signalAt(230, held()).target).toBe(0);
  });

  it('rejects an exit window at or above the entry window', () => {
    expect(() => donchianBreakout.create([], { entry: 20, exit: 20 })).toThrow(/exit < entry/);
  });
});

describe('rsi-mean-reversion', () => {
  it('refuses to buy a dip below the trend filter', () => {
    // A long decline: RSI is deeply oversold but price is under its trend line.
    const falling = ramp(Array.from({ length: 400 }, (_, i) => 500 - i));
    const strategy = rsiMeanReversion.create(falling, rsiMeanReversion.defaults);
    const signal = strategy.signalAt(399, null);
    expect(signal.target).toBe(0);
    expect(signal.reason).toMatch(/below trend filter/);
  });

  it('exits once RSI has reverted', () => {
    const rising = ramp(Array.from({ length: 400 }, (_, i) => 100 + i));
    const strategy = rsiMeanReversion.create(rising, rsiMeanReversion.defaults);
    const signal = strategy.signalAt(399, held(90));
    expect(signal.target).toBe(0);
    expect(signal.reason).toMatch(/reverted/);
  });

  it('rejects an entry level at or above the exit level', () => {
    expect(() => rsiMeanReversion.create([], { entryLevel: 60, exitLevel: 55 }))
      .toThrow(/entryLevel < exitLevel/);
  });
});

describe('buy-and-hold', () => {
  it('is always fully long and never sets a stop', () => {
    const strategy = getStrategy('buy-and-hold').create(ramp([1, 2, 3]), {});
    expect(strategy.signalAt(0, null)).toEqual({ target: 1, reason: 'benchmark: always long' });
    expect(strategy.warmup).toBe(0);
  });
});

describe('take-profit-scalp (the high-win-rate trap)', () => {
  const rising = ramp(Array.from({ length: 300 }, (_, i) => 100 + i * 0.1));

  it('enters immediately, because it never waits for a setup', () => {
    const strategy = takeProfitScalp.create(rising, takeProfitScalp.defaults);
    expect(strategy.signalAt(50, null).target).toBe(1);
  });

  it('exits the moment the tiny target is reached', () => {
    const strategy = takeProfitScalp.create(rising, { takeProfitPct: 1, stopPct: 50 });
    const open: Position = { ...held(50), entryPrice: 100 };
    expect(strategy.signalAt(50, open).target).toBe(0); // close 105 >= 101
    expect(strategy.signalAt(5, { ...open, entryPrice: 1_000 }).target).toBe(1);
  });

  it('holds a losing position rather than cutting it', () => {
    const falling = ramp(Array.from({ length: 100 }, (_, i) => 500 - i));
    const strategy = takeProfitScalp.create(falling, { takeProfitPct: 1, stopPct: 50 });
    const signal = strategy.signalAt(99, { ...held(250), entryPrice: 500 });
    expect(signal.target).toBe(1);
    expect(signal.reason).toMatch(/waiting for the tiny target/);
  });

  it('never ratchets the stop, which is what makes the losses large', () => {
    const strategy = takeProfitScalp.create(rising, { takeProfitPct: 5, stopPct: 50 });
    // Entry far above the current price, so the target is nowhere near hit and
    // the strategy is in its "hold the loser" branch.
    const underwater: Position = { ...held(60), entryPrice: 1_000 };
    expect(strategy.signalAt(299, underwater).stopPrice).toBe(60);
  });

  it('omits the stop entirely at stopPct = 0, the literal 100% win-rate setting', () => {
    const strategy = takeProfitScalp.create(rising, { takeProfitPct: 1, stopPct: 0 });
    expect(strategy.signalAt(50, null).stopPrice).toBeUndefined();
  });

  it('rejects a stop of 100% or more', () => {
    expect(() => takeProfitScalp.create(rising, { takeProfitPct: 1, stopPct: 100 }))
      .toThrow(RangeError);
  });
});

describe('the win-rate trap is real, not rhetorical', () => {
  // Synthetic data contains bear regimes, unlike the 2018-2026 BTC sample that
  // makes this shape look survivable. That is the point of testing against it.
  const candles = generateCandles({ bars: 2500, seed: 21 });
  const config = { ...DEFAULT_CONFIG, costs: DEFAULT_COSTS };
  const stops = [25, 50, 75, 95];

  const run = (stopPct: number) => computeMetrics(runBacktest(
    candles,
    takeProfitScalp.create(candles, { takeProfitPct: 0.5, stopPct }),
    config,
  ));

  it('manufactures a win rate above 85% at every stop width', () => {
    for (const stopPct of stops) {
      expect(run(stopPct).winRatePct, `stop ${stopPct}%`).toBeGreaterThan(85);
    }
  });

  it('pays for that win rate with a payoff ratio far below 1', () => {
    for (const stopPct of stops) {
      // Each loss is worth many wins; that is the trade-off being hidden.
      expect(run(stopPct).payoffRatio, `stop ${stopPct}%`).toBeLessThan(0.2);
    }
  });

  it('still loses money at every stop width once the sample contains bear markets', () => {
    for (const stopPct of stops) {
      expect(run(stopPct).totalReturnPct, `stop ${stopPct}%`).toBeLessThan(0);
    }
  });

  it('is flagged by the report as the shape that blows up', () => {
    const strategy = takeProfitScalp.create(candles, { takeProfitPct: 0.5, stopPct: 50 });
    const text = formatBacktest(runBacktest(candles, strategy, config));
    expect(text).toMatch(/REALITY CHECK/);
    expect(text).toMatch(/This shape blows up/);
  });
});
