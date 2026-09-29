import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import type { Candle } from '../src/domain/types.ts';
import { mulberry32 } from '../src/backtest/monte-carlo.ts';
import { buildSwarm, DEFAULT_SWARM, forecastAt } from '../src/swarm/swarm.ts';
import { evaluateSwarm, score } from '../src/swarm/score.ts';

const DAY = 86_400_000;
const FAST = { ...DEFAULT_SWARM, paths: 200 };

/** Log returns follow r[t] = phi * r[t-1] + noise: phi > 0 trends, phi < 0 reverts, 0 is a random walk. */
function series(n: number, phi: number, seed: number): Candle[] {
  const rand = mulberry32(seed);
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let x = Math.log(100);
  let r = 0;
  return Array.from({ length: n }, (_, i) => {
    r = phi * r + 0.02 * normal();
    x += r;
    const close = Math.exp(x);
    return { time: i * DAY, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1 };
  });
}

describe('swarm forecast', () => {
  const candles = series(700, 0.2, 1);

  it('never looks ahead: the forecast at t is the same with or without later bars', () => {
    const t = 500;
    const withFuture = forecastAt(buildSwarm(candles, FAST), t, 3);
    const withoutFuture = forecastAt(buildSwarm(candles.slice(0, t + 1), FAST), t, 3);
    expect(withoutFuture).toEqual(withFuture);
  });

  it('is reproducible: the same bar and seed give the same forecast', () => {
    const state = buildSwarm(candles, FAST);
    expect(forecastAt(state, 600)).toEqual(forecastAt(state, 600));
  });

  it('reports a crowd that sums to the whole population', () => {
    const f = forecastAt(buildSwarm(candles, FAST), 600);
    expect(f.crowd.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 9);
    expect(f.pUp).toBeGreaterThanOrEqual(0);
    expect(f.pUp).toBeLessThanOrEqual(1);
  });

  it('refuses to forecast before it has enough history to fit on', () => {
    expect(() => forecastAt(buildSwarm(candles, FAST), 10)).toThrow(/outside the forecastable range/);
  });
});

describe('swarm scorecard', () => {
  it('finds real skill when the market genuinely trends', () => {
    const { card } = evaluateSwarm(series(2000, 0.3, 2), { horizon: 1, config: FAST });
    expect(card.skillVsBaseRate).toBeGreaterThan(0);
    expect(card.tStatVsBaseRate).toBeGreaterThan(2);
  });

  it('finds real skill when the market genuinely mean-reverts', () => {
    const { card } = evaluateSwarm(series(2000, -0.3, 3), { horizon: 1, config: FAST });
    expect(card.skillVsBaseRate).toBeGreaterThan(0);
    expect(card.tStatVsBaseRate).toBeGreaterThan(2);
  });

  it('claims no skill on a pure random walk, where there is nothing to find', () => {
    for (const seed of [4, 5, 6]) {
      const { card } = evaluateSwarm(series(2000, 0, seed), { horizon: 1, config: FAST });
      expect(card.tStatVsBaseRate).toBeLessThan(2);
    }
  });

  it('computes Brier scores exactly', () => {
    const card = score([
      { t: 0, p: 0.8, baseRate: 0.5, up: true },
      { t: 1, p: 0.3, baseRate: 0.5, up: false },
    ]);
    expect(card.brier).toBeCloseTo((0.04 + 0.09) / 2, 12);
    expect(card.brierCoinFlip).toBeCloseTo(0.25, 12);
    expect(card.directionalHitRate).toBe(1);
  });
});

describe('swarm command', () => {
  it('prints a forecast and a scorecard on synthetic data', async () => {
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out += String(c); return true; });
    try {
      expect(await main(['swarm', '--synthetic', '--bars', '800'])).toBe(0);
      expect(out).toMatch(/SWARM FORECAST/);
      expect(out).toMatch(/P\(up\)/);
      out = '';
      expect(await main(['swarm', '--synthetic', '--bars', '800', '--evaluate'])).toBe(0);
      expect(out).toMatch(/SWARM SCORECARD/);
      expect(out).toMatch(/VERDICT/);
    } finally {
      spy.mockRestore();
    }
  });
});
