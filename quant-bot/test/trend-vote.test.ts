import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { trendVote } from '../src/strategy/trend-vote.ts';

const DAY = 86_400_000;
const bars = (values: number[]): Candle[] =>
  values.map((c, i) => ({ time: i * DAY, open: c, high: c, low: c, close: c, volume: 1 }));
const held: Position = {
  qty: 1, entryPrice: 100, entryTime: 0, stopPrice: undefined, highWaterPrice: 100, realizedPnl: 0, feesPaid: 0,
} as Position;
const P = { fast: 2, mid: 4, slow: 8, bandPct: 0 };

describe('trend-vote', () => {
  it('enters when at least two of the three trend tests are up', () => {
    // 8 flat bars, then a jump: above all three averages.
    const jump = bars([...Array.from({ length: 8 }, () => 100), 110]);
    expect(trendVote.create(jump, P).signalAt(8, null).target).toBe(1);
  });

  it('stays out when fewer than the required votes agree', () => {
    // Rise, then a sharp drop: below the fast and mid averages, still above the slow one.
    const dip = bars([80, 80, 80, 80, 100, 110, 120, 130, 105]);
    const s = trendVote.create(dip, { ...P, minVotes: 2 });
    expect(s.signalAt(8, null).target).toBe(0);
    expect(s.signalAt(8, null).reason).toMatch(/only 1 of 3/);
  });

  it('holds through a dip under one average, which a single fast average would sell on', () => {
    const climb = bars([100, 101, 102, 103, 104, 105, 106, 107, 108, 107.5]);
    // Price is under its 2-bar average but above the 4- and 8-bar ones.
    expect(trendVote.create(climb, P).signalAt(9, held).target).toBe(1);
  });

  it('exits once the votes fall below the requirement', () => {
    const crash = bars([100, 101, 102, 103, 104, 105, 106, 107, 80]);
    const r = trendVote.create(crash, P).signalAt(8, held);
    expect(r.target).toBe(0);
    expect(r.reason).toMatch(/only 0 of 3/);
  });

  it('needs a wider margin to enter than to keep holding (hysteresis)', () => {
    const near = bars([...Array.from({ length: 8 }, () => 100), 100.5]);
    const s = trendVote.create(near, { ...P, bandPct: 2 });
    expect(s.signalAt(8, null).target).toBe(0);
    expect(s.signalAt(8, held).target).toBe(1);
  });

  it('never sets a stop price, so position size is not throttled by risk sizing', () => {
    const jump = bars([...Array.from({ length: 8 }, () => 100), 110]);
    expect(trendVote.create(jump, P).signalAt(8, null).stopPrice).toBeUndefined();
  });

  it('only ever asks for all in or all out, which is what the live runner can do', () => {
    const wiggle = bars(Array.from({ length: 60 }, (_, i) => 100 + 10 * Math.sin(i / 4)));
    const s = trendVote.create(wiggle, P);
    for (let i = 8; i < wiggle.length; i += 1) expect([0, 1]).toContain(s.signalAt(i, i % 2 ? held : null).target);
  });

  it('rejects nonsense parameters', () => {
    expect(() => trendVote.create([], { fast: 50, mid: 40, slow: 200 })).toThrow(/fast < mid < slow/);
    expect(() => trendVote.create([], { minVotes: 4 })).toThrow(/minVotes/);
    expect(() => trendVote.create([], { bandPct: -1 })).toThrow(/bandPct/);
  });
});
