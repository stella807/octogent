import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WF_OPTIONS } from '../src/backtest/walk-forward.ts';
import { screenSymbol, shuffleBars } from '../src/backtest/screen.ts';
import { main } from '../src/cli.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { readScreenFile, screenPath } from '../src/screen-file.ts';
import { donchianBreakout } from '../src/strategy/index.ts';

describe('screenSymbol', () => {
  const candles = generateCandles({ bars: 2000, seed: 7 });

  it('reports the walk-forward numbers it judged', () => {
    const row = screenSymbol('SYN/USD', candles, donchianBreakout, DEFAULT_WF_OPTIONS, { minEfficiency: 0.5, minTrades: 1, minFolds: 1 });
    expect(row.symbol).toBe('SYN/USD');
    expect(row.bars).toBe(2000);
    expect(row.oosTrades).toBeGreaterThan(0);
    expect(row.oosReturnPct).not.toBeNull();
    // Whatever it decided, the reason has to say which rule decided it.
    expect(row.reason).toMatch(row.passed ? /efficiency .* out of sample/ : /efficiency|lost|trades/);
  });

  it('fails a symbol that did not trade enough to judge, whatever its numbers', () => {
    const row = screenSymbol('SYN/USD', candles, donchianBreakout, DEFAULT_WF_OPTIONS, {
      minEfficiency: -100,
      minTrades: 10_000,
      minFolds: 1,
    });
    expect(row.passed).toBe(false);
    expect(row.reason).toMatch(/out-of-sample trades/);
  });

  it('fails a pass that rests on too few folds, however good the ratio looks', () => {
    const row = screenSymbol('SYN/USD', candles, donchianBreakout, DEFAULT_WF_OPTIONS, {
      minEfficiency: -100,
      minTrades: 1,
      minFolds: 99,
    });
    expect(row.passed).toBe(false);
    expect(row.reason).toMatch(/rests on \d+ fold/);
  });

  it('shuffles bar order without changing the bars themselves', () => {
    const shuffled = shuffleBars(candles, 1);
    expect(shuffled).toHaveLength(candles.length);
    const moves = (cs: typeof candles) => cs.slice(1).map((c, i) => c.close / (cs[i] as typeof c).close).sort((a, b) => a - b);
    const a = moves(candles);
    const b = moves(shuffled);
    for (let i = 0; i < a.length; i += 1) expect(b[i]).toBeCloseTo(a[i] as number, 9);
    expect(shuffled.map((c) => c.close)).not.toEqual(candles.map((c) => c.close));
    expect(shuffled.every((c) => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))).toBe(true);
  });

  it('fails, rather than throws, on a market too young to walk forward', () => {
    const row = screenSymbol('NEW/USD', candles.slice(0, 40), donchianBreakout, DEFAULT_WF_OPTIONS);
    expect(row.passed).toBe(false);
    expect(row.reason).toMatch(/could not walk-forward/);
  });
});

describe('screen command', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'quant-bot-screen-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('screens a universe and saves what passed for paper --symbols screened', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out += String(c); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const state = join(dir, 'runner-state.json');

    const code = await main([
      'screen', '--synthetic', '--bars', '1500', '--symbols', 'AAA/USD,BBB/USD,CCC/USD',
      '--min-trades', '1', '--state', state,
    ]);

    expect(code).toBe(0);
    expect(out).toMatch(/SCREEN {2}donchian-breakout/);
    expect(out).toMatch(/PASSED \d+ of 3/);
    const saved = await readScreenFile(screenPath(state));
    expect(saved?.rows).toHaveLength(3);
    expect(saved?.strategy).toBe('donchian-breakout');
    // The saved list is exactly the rows marked as passing — nothing hand-added.
    expect(saved?.symbols).toEqual(saved?.rows.filter((r) => r.passed).map((r) => r.symbol));
    expect(JSON.parse(await readFile(screenPath(state), 'utf8')).exchange).toBe('binance');
  });
});
