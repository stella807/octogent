import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type BacktestConfig } from '../backtest/engine.ts';
import { DEFAULT_WF_OPTIONS } from '../backtest/walk-forward.ts';
import { loadCsv } from '../data/csv.ts';
import type { Candle } from '../domain/types.ts';
import { getStrategy } from '../strategy/index.ts';
import { evaluateSet, passesDev, type SetMetrics } from './research.ts';

/**
 * The same luck-controlled test the research loop uses, pointed at a folder of
 * exported price files (TradingView "Export chart data", one CSV per ticker).
 * It exists because stock, ETF, gold and forex history is not reachable from
 * the sandbox, so the files come from the user and nothing here fetches them.
 */

/**
 * Costs of a commission-free stock or ETF broker: a few basis points of
 * spread and slippage instead of crypto's ~60 bps a side. Callers can raise
 * them; lowering them to flatter a result is the mistake this test exists to
 * prevent, so the defaults are not zero.
 */
export function stockConfig(opts: { equity: number; feeBps?: number; slippageBps?: number }): BacktestConfig {
  return {
    ...DEFAULT_CONFIG,
    startingEquity: opts.equity,
    costs: { feeBps: opts.feeBps ?? 5, slippageBps: opts.slippageBps ?? 5, minOrderNotional: 1 },
    // The crypto fleet's 60% kill switch for hold-style rules; the stock default of 25% would halt a plain index hold in 2020 and 2022.
    limits: { ...DEFAULT_CONFIG.limits, maxDrawdownPct: 60, maxDailyLossPct: 20 },
    timeframe: '1d',
  };
}

export interface SkippedFile {
  readonly file: string;
  readonly reason: string;
}

export interface LoadedMarkets {
  readonly markets: Map<string, readonly Candle[]>;
  readonly skipped: SkippedFile[];
}

/** Every `*.csv` in the folder, keyed by file name without extension. Unreadable files are reported, not dropped. */
export async function loadMarketsDir(dir: string): Promise<LoadedMarkets> {
  const names = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
  const markets = new Map<string, readonly Candle[]>();
  const skipped: SkippedFile[] = [];
  for (const file of names) {
    try {
      const candles = await loadCsv(join(dir, file));
      if (candles.length === 0) throw new Error('no rows');
      markets.set(file.replace(/\.csv$/i, ''), candles);
    } catch (error) {
      skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { markets, skipped };
}

export interface MarketRow {
  readonly strategy: string;
  readonly metrics: SetMetrics;
}

export interface MarketReport {
  readonly markets: number;
  readonly rows: MarketRow[];
}

/** Each named strategy, at its default parameters, walk-forward tested on every market and on its shuffled prices. */
export function testMarkets(
  strategies: readonly string[],
  data: ReadonlyMap<string, readonly Candle[]>,
  config: BacktestConfig,
  shuffles = 5,
): MarketReport {
  const options = { ...DEFAULT_WF_OPTIONS, config };
  const rows = strategies.map((name) => ({ strategy: name, metrics: evaluateSet(getStrategy(name), data, options, shuffles) }));
  return { markets: data.size, rows };
}

/** Too few markets can neither confirm nor rule out a rule; the research loop's own floor is 30. */
const MIN_MARKETS = 30;

export function formatMarketTest(report: MarketReport): string {
  const pad = (s: string, n: number): string => s.padEnd(n);
  const lines = [
    `MARKET TEST  (${report.markets} markets; pretend money; each strategy at its default parameters)`,
    '='.repeat(78),
    `${pad('strategy', 22)} ${pad('tested', 7)} ${pad('beat luck', 10)} ${pad('luck p', 9)} ${pad('profitable', 11)} median return`,
  ];
  for (const { strategy, metrics: m } of report.rows) {
    lines.push(
      `${pad(strategy, 22)} ${pad(String(m.n), 7)} ${pad(`${m.beat}/${m.n}`, 10)} ${pad(m.signP.toFixed(4), 9)} ${pad(`${m.pos}/${m.n}`, 11)} ${m.medRet.toFixed(1)}%${passesDev(m) ? '  <- signal' : ''}`,
    );
  }
  lines.push('');
  if (report.markets < MIN_MARKETS) {
    lines.push(`Only ${report.markets} markets: too few markets to separate skill from luck (the research loop needs ${MIN_MARKETS}). Treat every row as a lead, not a result.`);
  } else {
    lines.push('A "signal" row is a lead, not a result: with many strategies tested, some pass by luck. Confirm it on markets it was not chosen on.');
  }
  lines.push('"beat luck" counts markets where the real prices beat the median of the same strategy on shuffled prices.');
  return lines.join('\n');
}
