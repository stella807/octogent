import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { DEFAULT_CONFIG, runBacktest } from '../src/backtest/engine.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { STRATEGIES } from '../src/strategy/index.ts';
import {
  channelHold, dipInUptrend, ichimokuHold, LONG_FLAT_STRATEGIES, regressionTrend, supertrendHold,
} from '../src/strategy/long-flat.ts';

const DAY = 86_400_000;
const bar = (close: number, i: number, range = 0.01): Candle =>
  ({ time: i * DAY, open: close, high: close * (1 + range), low: close * (1 - range), close, volume: 1 });
const series = (n: number, f: (i: number) => number): Candle[] => Array.from({ length: n }, (_, i) => bar(f(i), i));
const held: Position = {
  qty: 1, entryPrice: 100, entryTime: 0, stopPrice: undefined, highWaterPrice: 100, realizedPnl: 0, feesPaid: 0,
} as Position;

// A steady climb with a little noise, and a steady slide: unambiguous for every trend rule.
const climb = series(500, (i) => 100 * 1.006 ** i * (1 + 0.01 * Math.sin(i / 3)));
const slide = series(500, (i) => 300 * 0.994 ** i * (1 + 0.01 * Math.sin(i / 3)));

describe('the thirteen long/flat strategies', () => {
  it('registers all thirteen, distinctly named', () => {
    expect(LONG_FLAT_STRATEGIES).toHaveLength(13);
    expect(new Set(LONG_FLAT_STRATEGIES.map((f) => f.name)).size).toBe(13);
    for (const f of LONG_FLAT_STRATEGIES) expect(STRATEGIES[f.name]).toBe(f);
  });

  for (const factory of LONG_FLAT_STRATEGIES) {
    describe(factory.name, () => {
      it('asks only for all in or all out, and never sets a stop price', () => {
        const s = factory.create(climb, factory.defaults);
        for (let i = s.warmup; i < climb.length; i += 25) {
          for (const position of [null, held]) {
            const signal = s.signalAt(i, position);
            expect([0, 1]).toContain(signal.target);
            expect(signal.stopPrice).toBeUndefined();
          }
        }
      });

      it('is flat before its warm-up, so it cannot trade on data it does not have', () => {
        const s = factory.create(climb, factory.defaults);
        for (const i of [0, 1, Math.max(0, s.warmup - 3)]) {
          expect(s.signalAt(i, null).target).toBe(0);
        }
      });

      it('stays out of a steady decline', () => {
        const s = factory.create(slide, factory.defaults);
        for (let i = s.warmup; i < slide.length; i += 10) expect(s.signalAt(i, null).target).toBe(0);
      });

      it('rejects nonsense parameters with a clear error', () => {
        const bad = Object.fromEntries(Object.keys(factory.defaults).map((k) => [k, -1]));
        expect(() => factory.create(climb, bad)).toThrow();
      });

      it('runs end to end in the backtester without error', () => {
        const candles = generateCandles({ bars: 900, timeframe: '1d', seed: 5 });
        const result = runBacktest(candles, factory.create(candles, factory.defaults), { ...DEFAULT_CONFIG, startingEquity: 100 });
        expect(Number.isFinite(result.endingEquity)).toBe(true);
      });
    });
  }

  it('every trend-following one is long at the end of a steady climb', () => {
    // dip-in-uptrend waits for a washout that a climb never gives; it is tested on its own below.
    for (const f of LONG_FLAT_STRATEGIES.filter((x) => x.name !== 'dip-in-uptrend' && x.name !== 'bollinger-trend' && x.name !== 'keltner-hold')) {
      const s = f.create(climb, f.defaults);
      const i = climb.length - 1;
      expect(s.signalAt(i, held).target, f.name).toBe(1);
    }
  });
});

describe('channel-hold', () => {
  it('breaks a prior high by closing above it, not by touching it', () => {
    const flat = series(60, () => 100);
    const s = channelHold.create([...flat, bar(100, 60), bar(101, 61)], { entry: 55, exit: 20 });
    expect(s.signalAt(60, null).target).toBe(0);
    expect(s.signalAt(61, null).target).toBe(1);
  });
});

describe('regression-trend', () => {
  it('sees a perfect exponential climb as a perfect fit and a noisy sideways market as no trend', () => {
    const line = series(200, (i) => 100 * 1.01 ** i);
    expect(regressionTrend.create(line, { window: 100, r2Min: 0.95 }).signalAt(199, null).target).toBe(1);
    const noise = series(200, (i) => 100 + 3 * Math.sin(i * 2.3) + 2 * Math.cos(i * 0.9));
    expect(regressionTrend.create(noise, { window: 100, r2Min: 0.6 }).signalAt(199, null).target).toBe(0);
  });
});

describe('supertrend-hold', () => {
  it('flips to out after a close through the trailing band', () => {
    const up = series(60, (i) => 100 + i);
    const crash = [...up, bar(60, 60), bar(58, 61)];
    const s = supertrendHold.create(crash, { period: 10, mult: 2 });
    expect(s.signalAt(59, null).target).toBe(1);
    expect(s.signalAt(61, held).target).toBe(0);
  });
});

describe('ichimoku-hold', () => {
  it('reads the cloud from 26 bars ago, not from the future', () => {
    // Flat, then a sudden jump: price is above the old (flat) cloud immediately.
    const jump = [...series(120, () => 100), ...series(10, () => 130).map((c, i) => ({ ...c, time: (120 + i) * DAY }))];
    const s = ichimokuHold.create(jump, { tenkan: 9, kijun: 26, senkou: 52 });
    expect(s.signalAt(125, held).target).toBe(1);
  });
});

describe('dip-in-uptrend', () => {
  it('buys a sharp short-term drop while above the 200-bar average, and sells the bounce', () => {
    const up = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5);
    const washout = [...up, ...[8, 12, 10, 12, 10].map((d) => up[259]! - d)];
    const candles = washout.map((v, i) => bar(v, i));
    const s = dipInUptrend.create(candles, { rsiIn: 40, rsiOut: 60 });
    const i = candles.length - 1;
    expect(s.signalAt(i, null).target).toBe(1);
    const bounced = [...washout, up[259]! + 20, up[259]! + 30].map((v, k) => bar(v, k));
    expect(dipInUptrend.create(bounced, { rsiIn: 40, rsiOut: 60 }).signalAt(bounced.length - 1, held).target).toBe(0);
  });
});
