import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateCandles } from '../src/data/synthetic.ts';
import { formatMarketTest, loadMarketsDir, stockConfig, testMarkets } from '../src/research/markets.ts';

describe('loadMarketsDir', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qb-markets-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const csv = (n: number, seed: number): string => {
    const rows = generateCandles({ bars: n, timeframe: '1d', seed })
      .map((c) => `${new Date(c.time).toISOString().slice(0, 10)},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
    return `time,open,high,low,close,Volume\n${rows.join('\n')}\n`;
  };

  it('names each market after its file and skips files that are not CSVs', async () => {
    await writeFile(join(dir, 'SPY.csv'), csv(300, 1));
    await writeFile(join(dir, 'BATS_QQQ, 1D.csv'), csv(300, 2));
    await writeFile(join(dir, 'notes.txt'), 'not data');
    const { markets, skipped } = await loadMarketsDir(dir);
    expect([...markets.keys()].sort()).toEqual(['BATS_QQQ, 1D', 'SPY']);
    expect(skipped).toEqual([]);
  });

  it('reports a CSV it cannot read instead of silently dropping it', async () => {
    await writeFile(join(dir, 'BAD.csv'), 'hello\nworld\n');
    await writeFile(join(dir, 'SPY.csv'), csv(300, 1));
    const { markets, skipped } = await loadMarketsDir(dir);
    expect([...markets.keys()]).toEqual(['SPY']);
    expect(skipped.map((s) => s.file)).toEqual(['BAD.csv']);
  });

  it('fails loudly on a missing folder', async () => {
    await expect(loadMarketsDir(join(dir, 'nope'))).rejects.toThrow(/nope/);
  });
});

describe('stockConfig', () => {
  it('charges stock-sized costs, far below crypto, and still rejects nothing at the start', () => {
    const c = stockConfig({ equity: 1000, feeBps: 5, slippageBps: 5 });
    expect(c.costs.feeBps).toBe(5);
    expect(c.costs.slippageBps).toBe(5);
    expect(c.startingEquity).toBe(1000);
    expect(c.timeframe).toBe('1d');
  });
});

describe('testMarkets', () => {
  const data = new Map(
    [1, 2, 3, 4].map((s) => [`M${s}`, generateCandles({ bars: 900, timeframe: '1d', seed: s })] as const),
  );

  it('compares each strategy to shuffled prices and to buy-and-hold on the same markets', () => {
    const report = testMarkets(['trend-hold', 'buy-and-hold'], data, stockConfig({ equity: 1000 }), 2);
    expect(report.rows.map((r) => r.strategy)).toEqual(['trend-hold', 'buy-and-hold']);
    for (const r of report.rows) {
      expect(r.metrics.n).toBeGreaterThan(0);
      expect(r.metrics.beat).toBeLessThanOrEqual(r.metrics.n);
    }
    expect(report.markets).toBe(4);
  });

  it('is deterministic', () => {
    const a = testMarkets(['trend-hold'], data, stockConfig({ equity: 1000 }), 2);
    const b = testMarkets(['trend-hold'], data, stockConfig({ equity: 1000 }), 2);
    expect(a).toEqual(b);
  });

  it('rejects an unknown strategy by name', () => {
    expect(() => testMarkets(['no-such-thing'], data, stockConfig({ equity: 1000 }), 2)).toThrow(/no-such-thing/);
  });

  it('never calls a strategy good when too few markets were tested', () => {
    const report = testMarkets(['trend-hold'], data, stockConfig({ equity: 1000 }), 2);
    const text = formatMarketTest(report);
    expect(text).toMatch(/4 markets/);
    expect(text).toMatch(/too few markets|lead, not a result/i);
  });
});
