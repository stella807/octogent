import { join } from 'node:path';
import type { Candle, Timeframe } from '../domain/types.ts';
import { TIMEFRAME_MS } from '../domain/types.ts';
import type { Params } from '../strategy/types.ts';
import { STRATEGIES } from '../strategy/index.ts';
import type { PaperStatus } from './status.ts';

/** One paper bot: its own strategy, markets and $-account, run alongside the rest. */
export interface BotSpec {
  readonly name: string;
  readonly group: string;
  readonly strategy: string;
  readonly symbols: readonly string[];
  readonly timeframe: Timeframe;
  readonly params?: Params;
  readonly equity: number;
  readonly feeBps: number;
  readonly maxDrawdownPct: number;
}

export interface FleetFile {
  readonly exchange: string;
  readonly createdAt: string;
  readonly bots: readonly BotSpec[];
}

export const DAILY_SYMBOLS = ['BTC/USD', 'ETH/USD'] as const;
export const FAST_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD'] as const;

/** Strategies that passed a walk-forward test here, plus the two yardsticks. */
const DAILY_STRATEGIES = ['trend-hold', 'donchian-breakout', 'ema-zone-reversal', 'dca-safety', 'buy-and-hold', 'coin-flip'];
/** A spread of fast styles — breakout, crossover, momentum, reversion, grid, consensus — and the control. */
const FAST_STRATEGIES = [
  'donchian-breakout', 'ema-crossover', 'tsmom', 'bollinger-reversion',
  'rsi-mean-reversion', 'grid-range', 'master-consensus', 'coin-flip',
];

const EQUITY = 25;
/** Coinbase's lowest-tier fee, near enough; the default 0.1% flatters small accounts. */
const FEE_BPS = 60;

/**
 * The kill switch each bot was tested with. trend-hold's normal drawdown is
 * ~55%, so the 15% default would halt it on its first pullback; the two
 * yardsticks never halt, so they show the raw market and raw luck.
 */
function maxDrawdownFor(strategy: string): number {
  if (strategy === 'trend-hold') return 60;
  if (strategy === 'buy-and-hold' || strategy === 'coin-flip') return 100;
  return 15;
}

export function planFleet(topCoins: readonly string[]): BotSpec[] {
  const bot = (group: string, prefix: string, strategy: string, symbol: string, timeframe: Timeframe): BotSpec => ({
    name: `${prefix}-${strategy}-${slug(symbol)}`,
    group,
    strategy,
    symbols: [symbol],
    timeframe,
    equity: EQUITY,
    feeBps: FEE_BPS,
    maxDrawdownPct: maxDrawdownFor(strategy),
  });
  return [
    ...DAILY_STRATEGIES.flatMap((s) => DAILY_SYMBOLS.map((sym) => bot('daily strategies', 'daily', s, sym, '1d'))),
    ...topCoins.map((sym) => bot('trend-hold x32', 'top', 'trend-hold', sym, '1d')),
    ...FAST_STRATEGIES.flatMap((s) => FAST_SYMBOLS.map((sym) => bot('fast (1-minute)', 'fast', s, sym, '1m'))),
  ];
}

function slug(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Most-traded first, by average daily dollar volume over the last `window`
 * bars. Coins with less than `minBars` of history are dropped: trend-hold
 * needs 200 days before it can decide anything, and a bot that can only
 * report "warming up" is a wasted slot.
 */
export function rankByDollarVolume(
  candlesBySymbol: Readonly<Record<string, readonly Candle[]>>,
  options: { readonly minBars: number; readonly top: number; readonly window: number },
): string[] {
  return Object.entries(candlesBySymbol)
    .filter(([, candles]) => candles.length >= options.minBars)
    .map(([symbol, candles]) => {
      const recent = candles.slice(-options.window);
      const dollars = recent.reduce((sum, c) => sum + c.close * c.volume, 0) / Math.max(recent.length, 1);
      return { symbol, dollars };
    })
    .sort((a, b) => b.dollars - a.dollars)
    .slice(0, options.top)
    .map((r) => r.symbol);
}

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Validates a fleet file; each bot's name becomes a folder, so it must stay inside the fleet directory. */
export function parseFleet(json: string): FleetFile {
  const raw = JSON.parse(json) as Partial<FleetFile>;
  if (typeof raw.exchange !== 'string' || !Array.isArray(raw.bots)) throw new Error('fleet file needs "exchange" and "bots"');
  const seen = new Set<string>();
  for (const b of raw.bots as BotSpec[]) {
    if (typeof b.name !== 'string' || !SAFE_NAME.test(b.name)) throw new Error(`bad bot name "${String(b.name)}": use a-z, 0-9 and -`);
    if (seen.has(b.name)) throw new Error(`duplicate bot name "${b.name}"`);
    seen.add(b.name);
    if (!STRATEGIES[b.strategy]) throw new Error(`bot ${b.name}: unknown strategy "${b.strategy}"`);
    if (!(b.timeframe in TIMEFRAME_MS)) throw new Error(`bot ${b.name}: unsupported timeframe "${b.timeframe}"`);
    if (!Array.isArray(b.symbols) || b.symbols.length === 0) throw new Error(`bot ${b.name}: needs at least one symbol`);
    if (!(b.equity > 0) || !(b.feeBps >= 0) || !(b.maxDrawdownPct > 0)) throw new Error(`bot ${b.name}: equity, feeBps and maxDrawdownPct must be positive`);
  }
  return { exchange: raw.exchange, createdAt: String(raw.createdAt ?? ''), bots: raw.bots as BotSpec[] };
}

export function botStatePath(fleetDir: string, name: string): string {
  return join(fleetDir, name, 'runner-state.json');
}

export interface FleetRow {
  readonly spec: BotSpec;
  /** Null until the bot has written its account. */
  readonly status: PaperStatus | null;
}

export function formatFleetStatus(rows: readonly FleetRow[]): string {
  const signed = (v: number): string => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  const lines = ['PAPER FLEET  (simulated — no real money)', '='.repeat(86)];
  const groups = [...new Set(rows.map((r) => r.spec.group))];
  let allStart = 0;
  let allEquity = 0;
  for (const group of groups) {
    const members = rows.filter((r) => r.spec.group === group);
    lines.push('', group.toUpperCase());
    lines.push(`  ${'bot'.padEnd(34)} ${'equity'.padStart(8)} ${'profit'.padStart(8)} ${'%'.padStart(7)} ${'trades'.padStart(6)} ${'fees'.padStart(6)}`);
    const sorted = [...members].sort((a, b) => (b.status?.pnl ?? -Infinity) - (a.status?.pnl ?? -Infinity));
    let start = 0;
    let equity = 0;
    for (const { spec, status } of sorted) {
      const label = `${spec.strategy} ${spec.symbols.join(',')}`;
      if (!status) {
        lines.push(`  ${label.padEnd(34)} not started`);
        continue;
      }
      start += status.startingCash;
      equity += status.equity;
      lines.push(
        `  ${label.padEnd(34)} ${`$${status.equity.toFixed(2)}`.padStart(8)} ${signed(status.pnl).padStart(8)} ` +
        `${`${status.pnlPct >= 0 ? '+' : ''}${status.pnlPct.toFixed(1)}%`.padStart(7)} ` +
        `${String(status.buys + status.sells).padStart(6)} ${`$${status.feesPaid.toFixed(2)}`.padStart(6)}` +
        `${spec.strategy === 'coin-flip' ? '  <- luck control' : ''}${status.killed ? '  HALTED' : ''}`,
      );
    }
    allStart += start;
    allEquity += equity;
    if (start > 0) lines.push(`  ${'group total'.padEnd(34)} ${`$${equity.toFixed(2)}`.padStart(8)} ${signed(equity - start).padStart(8)}  of $${start.toFixed(2)}`);
  }
  if (allStart > 0) {
    lines.push('', `ALL BOTS  $${allEquity.toFixed(2)} of $${allStart.toFixed(2)}  (${signed(allEquity - allStart)})`);
  }
  lines.push(
    '',
    'With this many bots, the best one is often lucky. A bot has shown something only if it',
    'beats its group\'s coin-flip control — and keeps beating it for weeks, not hours.',
  );
  return lines.join('\n');
}
