import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { DEFAULT_CONFIG, runBacktest } from '../src/backtest/engine.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { STRATEGIES } from '../src/strategy/index.ts';
import { familyVote, momentumVote, VOTE_STRATEGIES, volumeTrend } from '../src/strategy/vote-strategies.ts';

const DAY = 86_400_000;
const bar = (close: number, i: number, volume = 1): Candle =>
  ({ time: i * DAY, open: close, high: close * 1.01, low: close * 0.99, close, volume });
const series = (n: number, f: (i: number) => number, v: (i: number) => number = () => 1): Candle[] =>
  Array.from({ length: n }, (_, i) => bar(f(i), i, v(i)));
const held: Position = {
  qty: 1, entryPrice: 100, entryTime: 0, stopPrice: undefined, highWaterPrice: 100, realizedPnl: 0, feesPaid: 0,
} as Position;

const climb = series(500, (i) => 100 * 1.006 ** i * (1 + 0.01 * Math.sin(i / 3)), (i) => 1 + i / 100);
const slide = series(500, (i) => 300 * 0.994 ** i * (1 + 0.01 * Math.sin(i / 3)));

describe('the three vote strategies', () => {
  it('are registered, distinctly named', () => {
    expect(VOTE_STRATEGIES.map((f) => f.name)).toEqual(['momentum-vote', 'volume-trend', 'family-vote']);
    for (const f of VOTE_STRATEGIES) expect(STRATEGIES[f.name]).toBe(f);
  });

  for (const factory of VOTE_STRATEGIES) {
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

      it('is flat before its warm-up', () => {
        const s = factory.create(climb, factory.defaults);
        for (const i of [0, 1, Math.max(0, s.warmup - 3)]) expect(s.signalAt(i, null).target).toBe(0);
      });

      it('stays out of a steady decline and is long at the end of a steady climb', () => {
        const down = factory.create(slide, factory.defaults);
        for (let i = down.warmup; i < slide.length; i += 10) expect(down.signalAt(i, null).target).toBe(0);
        expect(factory.create(climb, factory.defaults).signalAt(climb.length - 1, held).target).toBe(1);
      });

      it('rejects nonsense parameters', () => {
        expect(() => factory.create(climb, Object.fromEntries(Object.keys(factory.defaults).map((k) => [k, -1])))).toThrow();
      });

      it('runs end to end in the backtester', () => {
        const candles = generateCandles({ bars: 900, timeframe: '1d', seed: 9 });
        const r = runBacktest(candles, factory.create(candles, factory.defaults), { ...DEFAULT_CONFIG, startingEquity: 100 });
        expect(Number.isFinite(r.endingEquity)).toBe(true);
      });
    });
  }
});

describe('momentum-vote', () => {
  it('enters on two positive horizons and holds through a shallow dip on one', () => {
    // Up strongly over 90 and 180 bars, but down over the last 30.
    const path = [...Array.from({ length: 150 }, (_, i) => 100 + i), ...Array.from({ length: 31 }, (_, i) => 250 - i * 1.5)];
    const candles = path.map((v, i) => bar(v, i));
    const i = candles.length - 1;
    expect(momentumVote.create(candles, { minVotes: 2, bandPct: 0 }).signalAt(i, null).target).toBe(1);
    expect(momentumVote.create(candles, { minVotes: 3, bandPct: 0 }).signalAt(i, null).target).toBe(0);
  });
});

describe('volume-trend', () => {
  it('refuses a price breakout on falling volume and takes it on rising volume', () => {
    const price = (i: number): number => (i < 250 ? 100 : 100 + (i - 250) * 2);
    // The last 20 bars trade 3x the volume of the 80 before them, or a third of it.
    const rising = series(300, price, (i) => (i < 280 ? 10 : 30));
    const falling = series(300, price, (i) => (i < 280 ? 30 : 10));
    expect(volumeTrend.create(rising, { period: 200 }).signalAt(299, null).target).toBe(1);
    expect(volumeTrend.create(falling, { period: 200 }).signalAt(299, null).target).toBe(0);
  });

  it('does not enter when there is no volume history at all', () => {
    const dead = series(300, (i) => 100 + i, () => 0);
    expect(volumeTrend.create(dead, { period: 200 }).signalAt(299, null).target).toBe(0);
  });
});

describe('family-vote', () => {
  it('needs more agreement to enter than to keep holding', () => {
    // A strong climb into a shallow pullback: several families still agree, so it holds.
    const pull = [...Array.from({ length: 250 }, (_, i) => 100 * 1.008 ** i), ...Array.from({ length: 6 }, (_, k) => 100 * 1.008 ** 249 * (1 - 0.006 * (k + 1)))];
    const candles = pull.map((v, i) => bar(v, i));
    const i = candles.length - 1;
    const s = familyVote.create(candles, { enterVotes: 5, holdVotes: 3 });
    expect(s.signalAt(i, held).target).toBe(1);
  });

  it('rejects an inconsistent vote threshold', () => {
    expect(() => familyVote.create(climb, { enterVotes: 2, holdVotes: 4 })).toThrow(/holdVotes <= enterVotes/);
  });
});
