import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Candle } from '../domain/types.ts';
import { mulberry32 } from '../backtest/monte-carlo.ts';
import { screenSymbol, shuffleBars } from '../backtest/screen.ts';
import type { WalkForwardOptions } from '../backtest/walk-forward.ts';
import { STRATEGIES } from '../strategy/index.ts';
import type { Params, StrategyFactory } from '../strategy/types.ts';
import { binomialTail, botSpec, type BotSpec } from '../live/fleet.ts';

/**
 * A background research loop that tries to find better strategies without
 * fooling itself.
 *
 * Every candidate is screened on the development coins. Only a candidate that
 * already shows a signal there is tested, once, on coins that were never used
 * to choose anything. The holdout bar is 0.05 divided by the number of
 * holdout tests ever run, so the longer the loop runs the harder it is to pass
 * by luck: an honest search gets stricter with effort, where a naive one gets
 * easier. Whatever passes becomes a validator on pretend money and reaches
 * real money only through the fleet's own promotion rules.
 */

/**
 * Full-position strategies only. The stop-sized ones (donchian, tsmom, ...)
 * commit a sliver of the account per trade and cannot place $1 orders on a
 * small fleet, so a candidate built on them could never trade.
 */
const POOL_NAMES = [
  'trend-hold', 'trend-vote', 'trend-hold-dual', 'trend-hold-trail', 'trend-hold-slope',
  'channel-hold', 'golden-cross', 'macd-hold', 'rsi-trend', 'supertrend-hold', 'adx-trend', 'keltner-hold',
  'bollinger-trend', 'high-proximity', 'ichimoku-hold', 'calm-trend', 'regression-trend', 'dip-in-uptrend',
  'momentum-vote', 'volume-trend', 'family-vote',
];
export const RESEARCH_POOL: readonly StrategyFactory[] = POOL_NAMES.map((n) => STRATEGIES[n] as StrategyFactory);

export interface Candidate {
  readonly id: string;
  readonly strategy: string;
  readonly params: Params;
}

/** Short, stable id for a strategy at specific parameters (FNV-1a over a canonical form). */
export function candidateId(strategy: string, params: Params): string {
  const canonical = JSON.stringify([strategy, Object.entries(params).sort(([a], [b]) => a.localeCompare(b))]);
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

const MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2];

/**
 * Candidate number `trial`: a pool strategy with each parameter scaled from
 * its default. Reproducible from the trial number alone, so any result can be
 * re-derived. Null when the draw is not a valid configuration (the trial still
 * counts, since it was a draw).
 */
export function sampleCandidate(trial: number, probe: readonly Candle[]): Candidate | null {
  const rand = mulberry32((Math.imul(trial, 2654435761) >>> 0) || 1);
  const factory = RESEARCH_POOL[Math.floor(rand() * RESEARCH_POOL.length)] as StrategyFactory;
  const params: Record<string, number> = {};
  for (const [key, base] of Object.entries(factory.defaults)) {
    const scaled = base * (MULTIPLIERS[Math.floor(rand() * MULTIPLIERS.length)] as number);
    params[key] = Number.isInteger(base) ? Math.max(1, Math.round(scaled)) : Number(scaled.toFixed(2));
  }
  try {
    factory.create(probe, params);
  } catch {
    return null;
  }
  return { id: candidateId(factory.name, params), strategy: factory.name, params };
}

export interface SetMetrics {
  /** Coins the strategy could be tested on. */
  readonly n: number;
  /** Coins where its out-of-sample return beat the median of its own shuffled-price runs. */
  readonly beat: number;
  /** Chance of that many beats if luck alone decided each coin. */
  readonly signP: number;
  readonly pos: number;
  readonly medRet: number;
  readonly medDd: number;
  readonly medTrades: number;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/**
 * The strategy, at its own parameters fixed (no in-sample re-tuning), walk-
 * forward tested on every coin and on that coin's shuffled prices. Skill has
 * to show on the real prices and not on the scrambled ones.
 */
export function evaluateSet(
  factory: StrategyFactory,
  data: ReadonlyMap<string, readonly Candle[]>,
  options: WalkForwardOptions,
  shuffles = 5,
): SetMetrics {
  const rets: number[] = [];
  const dds: number[] = [];
  const trades: number[] = [];
  let beat = 0;
  let pos = 0;
  for (const [market, candles] of data) {
    const real = screenSymbol(market, candles, factory, options);
    if (real.oosReturnPct === null) continue;
    const luck = Array.from({ length: shuffles }, (_, k) => screenSymbol(market, shuffleBars(candles, k + 1), factory, options).oosReturnPct ?? 0);
    rets.push(real.oosReturnPct);
    dds.push(real.oosMaxDrawdownPct ?? 0);
    trades.push(real.oosTrades);
    if (real.oosReturnPct > median(luck)) beat += 1;
    if (real.oosReturnPct > 0) pos += 1;
  }
  const n = rets.length;
  return {
    n, beat, signP: n > 0 ? binomialTail(beat, n, 0.5) : 1, pos,
    medRet: median(rets), medDd: median(dds), medTrades: median(trades),
  };
}

const MIN_COINS = 30;

/** Worth a holdout test: a real signal on the development coins. */
export function passesDev(m: SetMetrics): boolean {
  return m.n >= MIN_COINS && m.signP < 0.05 && m.medRet > 0 && m.pos > m.n / 2;
}

/** The bar for the Nth holdout test ever run: Bonferroni over all of them. */
export function holdoutAlpha(holdoutTests: number): number {
  return 0.05 / Math.max(1, holdoutTests);
}

export function passesHoldout(m: SetMetrics, holdoutTests: number): boolean {
  return m.n >= MIN_COINS && m.signP < holdoutAlpha(holdoutTests) && m.medRet > 0 && m.pos > m.n / 2;
}

export interface TrialRecord {
  readonly id: string;
  readonly strategy: string;
  readonly params: Params;
  readonly at: string;
  readonly dev: SetMetrics;
  readonly devPassed: boolean;
  readonly holdout?: SetMetrics;
  readonly confirmed?: boolean;
}

export interface Confirmed {
  readonly id: string;
  readonly strategy: string;
  readonly params: Params;
  readonly at: string;
}

export interface ResearchState {
  readonly startedAt: string;
  /** Every draw, including invalid ones: the denominator for "what chance alone would produce". */
  readonly trials: number;
  readonly devPasses: number;
  /** Every holdout test ever run: the denominator of the holdout bar. */
  readonly holdoutTests: number;
  readonly lastRunAt?: string;
  readonly recent: readonly TrialRecord[];
  readonly confirmed: readonly Confirmed[];
}

export function emptyState(now: string): ResearchState {
  return { startedAt: now, trials: 0, devPasses: 0, holdoutTests: 0, recent: [], confirmed: [] };
}

export async function loadState(path: string): Promise<ResearchState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ResearchState;
    if (typeof parsed.trials !== 'number') throw new Error('bad state');
    return parsed;
  } catch {
    return emptyState(new Date().toISOString());
  }
}

/** Write-then-rename, so a reader never sees a half-written file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

export const saveState = (path: string, state: ResearchState): Promise<void> => writeJsonAtomic(path, state);

/** The candidates the research loop confirmed, for the fleet to pick up; empty when none. */
export async function loadConfirmed(path: string): Promise<Confirmed[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Confirmed[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Validators for each confirmed candidate on BTC and ETH, carrying the candidate's own parameters. */
export function confirmedBotSpecs(confirmed: readonly Confirmed[], equity: number): BotSpec[] {
  return confirmed.flatMap((c) => ['BTC/USD', 'ETH/USD'].map((symbol) => {
    const base = botSpec('research', 'research', c.strategy, symbol, '1d', equity);
    return { ...base, name: `research-${c.id}-${symbol.split('/')[0]!.toLowerCase()}usd`, params: c.params };
  }));
}

export function formatResearchStatus(s: ResearchState): string {
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  const lines = [
    'RESEARCH  (background search for better strategies; pretend money only)',
    '='.repeat(72),
    `  Running since ${s.startedAt.slice(0, 16).replace('T', ' ')} UTC${s.lastRunAt ? `, last round ${s.lastRunAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
    `  ${s.trials} candidates drawn; ${s.devPasses} showed a signal on the development coins and went to the holdout (${s.holdoutTests} holdout tests).`,
    `  By chance alone, about ${Math.round(s.trials * 0.05)} would pass development by chance (5% bar), so a passing candidate is a lead, not a result.`,
    `  The holdout bar is tightened by every holdout test run: p < ${pct(holdoutAlpha(s.holdoutTests + 1))} now.`,
  ];
  if (s.confirmed.length === 0) {
    lines.push('', '  No candidate has been confirmed on the unseen coins. Nothing has been added to the fleet.');
  } else {
    lines.push('', `  CONFIRMED (${s.confirmed.length}), running as validators on BTC and ETH:`);
    for (const c of s.confirmed) lines.push(`    ${c.id}  ${c.strategy} ${JSON.stringify(c.params)}  (${c.at.slice(0, 10)})`);
  }
  const leads = s.recent.filter((r) => r.devPassed).slice(-5);
  if (leads.length > 0) {
    lines.push('', '  LATEST LEADS (passed development):');
    for (const r of leads) {
      lines.push(`    ${r.id}  ${r.strategy}: development ${r.dev.beat}/${r.dev.n} beat shuffled, median ${r.dev.medRet.toFixed(0)}%` +
        (r.holdout ? `; holdout ${r.holdout.beat}/${r.holdout.n}, median ${r.holdout.medRet.toFixed(0)}%, ${r.confirmed ? 'CONFIRMED' : 'not confirmed'}` : ''));
    }
  }
  return lines.join('\n');
}
