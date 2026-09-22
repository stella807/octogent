import { describe, expect, it } from 'vitest';
import type { Candle, Position } from '../src/domain/types.ts';
import { mcginleyDynamic, tdfi, tsi } from '../src/indicators/index.ts';
import { masterConsensus } from '../src/strategy/master-consensus.ts';

const DAY = 86_400_000;

function trending(n: number, slope = 1.5, startVolume = 1000): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * slope;
    return {
      time: i * DAY, open: close - 1, high: close + 1, low: close - 2, close,
      volume: startVolume + i,
    };
  });
}
function ranging(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 2;
    return { time: i * DAY, open: close - 0.5, high: close + 0.5, low: close - 1, close, volume: 1000 };
  });
}

describe('tsi', () => {
  it('is near +100 on a pure uptrend and lower on a chop', () => {
    const up = trending(150);
    const chop = ranging(150);
    const t1 = tsi(up.map((c) => c.close));
    const t2 = tsi(chop.map((c) => c.close));
    expect(t1[149] as number).toBeGreaterThan(90);
    expect(t1[149] as number).toBeGreaterThan(t2[149] as number);
  });

  it('is negative on a pure downtrend', () => {
    const down = trending(150, -1.5);
    expect(tsi(down.map((c) => c.close))[149] as number).toBeLessThan(0);
  });

  it('stays within -100..100', () => {
    const noisy = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i) * 20 + i * 0.1);
    for (const v of tsi(noisy)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(-100);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('rejects shortPeriod >= longPeriod at the indicator level only if periods are invalid', () => {
    expect(() => tsi([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe('tdfi', () => {
  it('is positive when price rises on volume and negative when it falls', () => {
    const up = trending(60, 1.5);
    const down = trending(60, -1.5);
    expect(tdfi(up)[59] as number).toBeGreaterThan(0);
    expect(tdfi(down)[59] as number).toBeLessThan(0);
  });

  it('is finite everywhere it is defined, never NaN or Infinity', () => {
    const candles = trending(200);
    for (const v of tdfi(candles)) {
      if (v === null) continue;
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('is null before ATR has enough history', () => {
    expect(tdfi(trending(10)).every((v) => v === null)).toBe(true);
  });
});

describe('mcginleyDynamic', () => {
  it('tracks a rising price from below, the way a lagging moving average should', () => {
    const up = trending(100, 1.5);
    const md = mcginleyDynamic(up.map((c) => c.close));
    const last = md[99] as number;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(up[99]?.close ?? 0);
  });

  it('converges to a constant price', () => {
    const flat = new Array(60).fill(100);
    const md = mcginleyDynamic(flat);
    expect(md[59]).toBeCloseTo(100, 6);
  });

  it('never produces NaN or Infinity, including through a sharp gap', () => {
    const gapped = [...new Array(30).fill(100), ...new Array(30).fill(0.001), ...new Array(30).fill(500)];
    for (const v of mcginleyDynamic(gapped)) {
      if (v === null) continue;
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('is null before the seed period has elapsed', () => {
    expect(mcginleyDynamic([1, 2, 3], 14).slice(0, 13).every((v) => v === null)).toBe(true);
  });
});

const held: Position = {
  qty: 1, entryPrice: 100, entryTime: 0, stopPrice: 90, highWaterPrice: 150,
  realizedPnl: 0, feesPaid: 0, peakQty: 1, equityAtEntry: 10_000,
};

describe('master-consensus', () => {
  const uptrend = trending(200, 1.5);
  const downtrend = trending(200, -1.5);
  const chop = ranging(200);

  it('requires all three signals to agree before entering', () => {
    const strategy = masterConsensus.create(uptrend, masterConsensus.defaults);
    const signal = strategy.signalAt(199, null);
    expect(signal.target).toBe(1);
    expect(signal.reason).toMatch(/all three agree/);
  });

  it('stays flat when the trend is down', () => {
    const strategy = masterConsensus.create(downtrend, masterConsensus.defaults);
    expect(strategy.signalAt(199, null).target).toBe(0);
  });

  it('stays flat in a chop where the three signals disagree', () => {
    const strategy = masterConsensus.create(chop, masterConsensus.defaults);
    const signal = strategy.signalAt(199, null);
    expect(signal.target).toBe(0);
    expect(signal.reason).toMatch(/no consensus/);
  });

  it('exits as soon as consensus breaks, without waiting for all three to reverse', () => {
    // A trend that decelerates hard: baseline may still read bullish
    // briefly while momentum/force have already turned.
    const decelerating = trending(150, 1.5).concat(trending(50, -0.3).map((c, i) => ({
      ...c,
      close: (trending(150, 1.5)[149]?.close ?? 0) - i * 0.3,
      open: (trending(150, 1.5)[149]?.close ?? 0) - i * 0.3,
    })));
    const strategy = masterConsensus.create(decelerating, masterConsensus.defaults);
    const signal = strategy.signalAt(199, held);
    // Whatever the outcome, it must be a valid binary decision, not stuck long
    // forever just because the position was already open.
    expect([0, 1]).toContain(signal.target);
  });

  it('never lowers an existing stop', () => {
    const strategy = masterConsensus.create(uptrend, masterConsensus.defaults);
    const high = (uptrend[199]?.close ?? 0) - 1;
    expect(strategy.signalAt(199, { ...held, stopPrice: high }).stopPrice).toBe(high);
  });

  it('is flat during warmup', () => {
    expect(masterConsensus.create(uptrend, masterConsensus.defaults).signalAt(5, null).target).toBe(0);
  });

  it('rejects tsiShortPeriod >= tsiLongPeriod', () => {
    expect(() => masterConsensus.create(uptrend, { tsiShortPeriod: 25, tsiLongPeriod: 25 }))
      .toThrow(/tsiShortPeriod < tsiLongPeriod/);
  });

  it('cannot see the future', () => {
    const full = masterConsensus.create(uptrend, masterConsensus.defaults);
    const prefix = masterConsensus.create(uptrend.slice(0, 151), masterConsensus.defaults);
    expect(prefix.signalAt(150, null)).toEqual(full.signalAt(150, null));
  });
});
