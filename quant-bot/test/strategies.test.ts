import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { donchianBreakout, emaCrossover, getStrategy, rsiMeanReversion, STRATEGIES } from '../src/strategy/index.ts';

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
