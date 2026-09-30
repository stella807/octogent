import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { DEFAULT_CONFIG } from '../src/backtest/engine.ts';
import { DEFAULT_WF_OPTIONS } from '../src/backtest/walk-forward.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { STRATEGIES } from '../src/strategy/index.ts';
import { sameTrade, strategyFor, botSpec, type BotSpec } from '../src/live/fleet.ts';
import {
  candidateId, confirmedBotSpecs, emptyState, evaluateSet, formatResearchStatus, holdoutAlpha, loadState,
  passesDev, passesHoldout, RESEARCH_POOL, sampleCandidate, saveState, type SetMetrics,
} from '../src/research/research.ts';

const metrics = (over: Partial<SetMetrics> = {}): SetMetrics =>
  ({ n: 40, beat: 30, signP: 0.001, pos: 25, medRet: 8, medDd: 30, medTrades: 6, ...over });

describe('candidateId', () => {
  it('is stable and ignores the order parameters are listed in', () => {
    expect(candidateId('trend-vote', { a: 1, b: 2 })).toBe(candidateId('trend-vote', { b: 2, a: 1 }));
    expect(candidateId('trend-vote', { a: 1 })).not.toBe(candidateId('trend-vote', { a: 2 }));
    expect(candidateId('trend-vote', { a: 1 })).not.toBe(candidateId('trend-hold', { a: 1 }));
  });
});

describe('sampleCandidate', () => {
  const probe = generateCandles({ bars: 600, timeframe: '1d', seed: 3 });

  it('is reproducible from the trial number alone', () => {
    for (const trial of [1, 2, 50, 999]) {
      expect(sampleCandidate(trial, probe)).toEqual(sampleCandidate(trial, probe));
    }
  });

  it('only returns parameters the strategy accepts, drawn from its own pool', () => {
    const pool = new Set(RESEARCH_POOL.map((f) => f.name));
    for (let trial = 1; trial <= 200; trial += 1) {
      const c = sampleCandidate(trial, probe);
      if (c === null) continue;
      expect(pool.has(c.strategy)).toBe(true);
      expect(() => STRATEGIES[c.strategy]!.create(probe, c.params)).not.toThrow();
    }
  });

  it('keeps only full-position strategies, since stop-sized ones cannot trade small accounts', () => {
    const names = RESEARCH_POOL.map((f) => f.name);
    expect(names).toContain('trend-vote');
    expect(names).not.toContain('donchian-breakout');
    expect(names).not.toContain('tsmom');
  });
});

describe('the gates', () => {
  it('needs a real signal in development: beats shuffled, positive median, profitable on most coins', () => {
    expect(passesDev(metrics())).toBe(true);
    expect(passesDev(metrics({ signP: 0.2 }))).toBe(false);
    expect(passesDev(metrics({ medRet: -1 }))).toBe(false);
    expect(passesDev(metrics({ pos: 10 }))).toBe(false);
    expect(passesDev(metrics({ n: 10 }))).toBe(false);
  });

  it('tightens the holdout bar with every holdout test ever run, so running longer cannot fool it', () => {
    expect(holdoutAlpha(1)).toBe(0.05);
    expect(holdoutAlpha(50)).toBeCloseTo(0.001, 12);
    expect(passesHoldout(metrics({ signP: 0.004 }), 5)).toBe(true);
    expect(passesHoldout(metrics({ signP: 0.004 }), 100)).toBe(false);
  });

  it('still demands positive money at the holdout, however strong the sign test', () => {
    expect(passesHoldout(metrics({ signP: 1e-9, medRet: -2 }), 1)).toBe(false);
    expect(passesHoldout(metrics({ signP: 1e-9, pos: 5 }), 1)).toBe(false);
  });
});

describe('evaluateSet', () => {
  const opts = { ...DEFAULT_WF_OPTIONS, config: { ...DEFAULT_CONFIG, startingEquity: 2.5, timeframe: '1d' as const } };
  const data = (seeds: number[]): Map<string, readonly Candle[]> =>
    new Map(seeds.map((s) => [`C${s}/USD`, generateCandles({ bars: 800, timeframe: '1d', seed: s })]));

  it('counts coins, beats and profitable coins consistently', () => {
    const m = evaluateSet(STRATEGIES['trend-hold']!, data([1, 2, 3, 4]), opts, 2);
    expect(m.n).toBeGreaterThan(0);
    expect(m.n).toBeLessThanOrEqual(4);
    expect(m.beat).toBeLessThanOrEqual(m.n);
    expect(m.pos).toBeLessThanOrEqual(m.n);
    expect(m.signP).toBeGreaterThan(0);
    expect(m.signP).toBeLessThanOrEqual(1);
  });

  it('is deterministic', () => {
    const d = data([5, 6]);
    expect(evaluateSet(STRATEGIES['trend-hold']!, d, opts, 2)).toEqual(evaluateSet(STRATEGIES['trend-hold']!, d, opts, 2));
  });

  it('returns an empty result for no data rather than a fake pass', () => {
    const m = evaluateSet(STRATEGIES['trend-hold']!, new Map(), opts, 2);
    expect(m.n).toBe(0);
    expect(passesDev(m)).toBe(false);
  });
});

describe('research state', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qb-research-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips through disk and starts empty', async () => {
    const path = join(dir, 'state.json');
    expect((await loadState(path)).trials).toBe(0);
    const s = { ...emptyState('2026-09-30T00:00:00Z'), trials: 7, holdoutTests: 2 };
    await saveState(path, s);
    expect(await loadState(path)).toEqual(s);
  });

  it('says plainly how many false discoveries chance alone would produce', () => {
    const text = formatResearchStatus({ ...emptyState('x'), trials: 200, devPasses: 12, holdoutTests: 12 });
    expect(text).toMatch(/200 candidates/);
    expect(text).toMatch(/about 10 would pass development by chance/);
    expect(text).toMatch(/holdout bar.*0\.38%/);
    expect(text).toMatch(/No candidate has been confirmed/);
  });
});

describe('confirmed candidates become validators, never traders', () => {
  it('builds daily BTC and ETH validator specs that carry the candidate\'s own parameters', () => {
    const specs = confirmedBotSpecs([{ id: 'abc123', strategy: 'trend-vote', params: { fast: 40 }, at: 'x' }], 2.5);
    expect(specs.map((s) => s.symbols[0])).toEqual(['BTC/USD', 'ETH/USD']);
    for (const s of specs) {
      expect(s.params).toEqual({ fast: 40 });
      expect(s.group).toBe('research');
      expect(s.name).toMatch(/^research-abc123-/);
      expect(s.equity).toBe(2.5);
    }
  });
});

describe('bots that differ only in parameters', () => {
  const a = botSpec('g', 'x', 'trend-vote', 'BTC/USD', '1d', 2.5);
  const b: BotSpec = { ...a, name: 'other', params: { fast: 40 } };

  it('are different trades, so a tuned candidate is not dropped as a duplicate', () => {
    expect(sameTrade(a, a)).toBe(true);
    expect(sameTrade(a, b)).toBe(false);
    expect(sameTrade(b, { ...b, name: 'again' })).toBe(true);
  });

  it('are tested with their own parameters fixed, not re-tuned by the walk-forward grid', () => {
    const f = strategyFor(b);
    expect(f.defaults['fast']).toBe(40);
    expect(f.grid).toEqual({});
    expect(strategyFor(a)).toBe(STRATEGIES['trend-vote']);
  });
});
