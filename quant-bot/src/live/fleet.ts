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

export interface FundedBot {
  readonly name: string;
  readonly at: string;
  /** Which bots' realized profit paid for it, and how much each gave. */
  readonly fundedBy: Readonly<Record<string, number>>;
}

export interface FleetFile {
  readonly exchange: string;
  readonly createdAt: string;
  readonly bots: readonly BotSpec[];
  /** Bots waiting to be added, in order, once profits can pay for them. */
  readonly reserve?: readonly BotSpec[];
  readonly added?: readonly FundedBot[];
}

/** What one new bot costs: the $25 account every bot starts with. */
export const EXPANSION_COST = 25;

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

function bot(group: string, prefix: string, strategy: string, symbol: string, timeframe: Timeframe): BotSpec {
  return {
    name: `${prefix}-${strategy}-${slug(symbol)}`,
    group,
    strategy,
    symbols: [symbol],
    timeframe,
    equity: EQUITY,
    feeBps: FEE_BPS,
    maxDrawdownPct: maxDrawdownFor(strategy),
  };
}

export function planFleet(topCoins: readonly string[]): BotSpec[] {
  return [
    ...DAILY_STRATEGIES.flatMap((s) => DAILY_SYMBOLS.map((sym) => bot('daily strategies', 'daily', s, sym, '1d'))),
    ...topCoins.map((sym) => bot('trend-hold x32', 'top', 'trend-hold', sym, '1d')),
    ...FAST_STRATEGIES.flatMap((s) => FAST_SYMBOLS.map((sym) => bot('fast (1-minute)', 'fast', s, sym, '1m'))),
  ];
}

/**
 * Ten bots: the strategies with the best evidence, one benchmark and one
 * coin-flip control per speed, so each group can still be judged against luck.
 * Names match the full fleet's, so a bot kept from it keeps its account.
 * dca-safety is left out: its $0.89 base order is under the $1 minimum at $25.
 */
export function planCoreFleet(): BotSpec[] {
  const daily = 'daily strategies';
  const fast = 'fast (1-minute)';
  return [
    bot(daily, 'daily', 'trend-hold', 'BTC/USD', '1d'),
    bot(daily, 'daily', 'trend-hold', 'ETH/USD', '1d'),
    bot(daily, 'daily', 'donchian-breakout', 'BTC/USD', '1d'),
    bot(daily, 'daily', 'ema-zone-reversal', 'BTC/USD', '1d'),
    bot(daily, 'daily', 'buy-and-hold', 'BTC/USD', '1d'),
    bot(daily, 'daily', 'coin-flip', 'BTC/USD', '1d'),
    bot(fast, 'fast', 'donchian-breakout', 'BTC/USD', '1m'),
    bot(fast, 'fast', 'ema-crossover', 'BTC/USD', '1m'),
    bot(fast, 'fast', 'tsmom', 'BTC/USD', '1m'),
    bot(fast, 'fast', 'coin-flip', 'BTC/USD', '1m'),
  ];
}

/**
 * The queue of bots to add as profits allow: every bot in the full plan not
 * already running, in the full plan's order — daily strategies, then
 * trend-hold across the most-traded coins, then the fast bots, whose record
 * so far is the weakest. dca-safety is left out because its first order is
 * under the exchange minimum at $25.
 */
export function planReserve(full: readonly BotSpec[], running: readonly BotSpec[]): BotSpec[] {
  const taken = new Set(running.map((b) => b.name));
  return full.filter((b) => !taken.has(b.name) && b.strategy !== 'dca-safety');
}

/** One bot's money, read from its paper account. */
export interface BotFunds {
  readonly name: string;
  readonly startingCash: number;
  readonly cash: number;
  /** Cash plus open positions at current prices. */
  readonly equity: number;
  /** Profit from closed trades, net of fees. */
  readonly realized: number;
  readonly withdrawn: number;
}

/**
 * Where the money for one more bot comes from, or null if the fleet cannot
 * afford it yet. Two conditions, both required:
 *
 * 1. The fleet as a whole is up by enough to cover every bot added so far
 *    plus this one, marked to market. One bot's win cannot pay for a new
 *    bot while the rest of the fleet has lost more than it made.
 * 2. The $25 comes from profit that is already realized and sitting in cash.
 *    Paper gains on an open position can vanish before they are banked, and
 *    no donor is drawn below its own starting cash, so the original stake is
 *    never spent on expansion.
 */
export function planExpansion(
  bots: readonly BotFunds[],
  fleet: { readonly principal: number; readonly added: number; readonly cost: number },
): Record<string, number> | null {
  const equity = bots.reduce((sum, b) => sum + b.equity, 0);
  if (equity - fleet.principal < fleet.cost * (fleet.added + 1)) return null;
  const donors = bots
    .map((b) => ({ name: b.name, spare: Math.min(b.cash - b.startingCash, b.realized - b.withdrawn) }))
    .filter((d) => d.spare > 0)
    .sort((a, b) => b.spare - a.spare);
  const plan: Record<string, number> = {};
  let still = fleet.cost;
  for (const d of donors) {
    if (still <= 1e-9) break;
    const take = Math.min(d.spare, still);
    plan[d.name] = Number(take.toFixed(8));
    still -= take;
  }
  return still > 1e-9 ? null : plan;
}

/** Fleet profit so far, and how much more it needs before the next bot is paid for. */
export function expansionProgress(fleet: {
  readonly principal: number;
  readonly fleetEquity: number;
  readonly added: number;
  readonly cost: number;
}): { profit: number; needed: number } {
  const profit = Number((fleet.fleetEquity - fleet.principal).toFixed(8));
  return { profit, needed: Number(Math.max(0, fleet.cost * (fleet.added + 1) - profit).toFixed(8)) };
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
  const reserve = Array.isArray(raw.reserve) ? (raw.reserve as BotSpec[]) : [];
  for (const b of [...(raw.bots as BotSpec[]), ...reserve]) {
    if (typeof b.name !== 'string' || !SAFE_NAME.test(b.name)) throw new Error(`bad bot name "${String(b.name)}": use a-z, 0-9 and -`);
    if (seen.has(b.name)) throw new Error(`duplicate bot name "${b.name}"`);
    seen.add(b.name);
    if (!STRATEGIES[b.strategy]) throw new Error(`bot ${b.name}: unknown strategy "${b.strategy}"`);
    if (!(b.timeframe in TIMEFRAME_MS)) throw new Error(`bot ${b.name}: unsupported timeframe "${b.timeframe}"`);
    if (!Array.isArray(b.symbols) || b.symbols.length === 0) throw new Error(`bot ${b.name}: needs at least one symbol`);
    if (!(b.equity > 0) || !(b.feeBps >= 0) || !(b.maxDrawdownPct > 0)) throw new Error(`bot ${b.name}: equity, feeBps and maxDrawdownPct must be positive`);
  }
  return {
    exchange: raw.exchange,
    createdAt: String(raw.createdAt ?? ''),
    bots: raw.bots as BotSpec[],
    reserve,
    added: Array.isArray(raw.added) ? raw.added : [],
  };
}

export function botStatePath(fleetDir: string, name: string): string {
  return join(fleetDir, name, 'runner-state.json');
}

export interface FleetRow {
  readonly spec: BotSpec;
  /** Null until the bot has written its account. */
  readonly status: PaperStatus | null;
}

export interface ExpansionSummary {
  readonly added: number;
  readonly queued: number;
  readonly profit: number;
  readonly needed: number;
}

export function formatFleetStatus(rows: readonly FleetRow[], expansion?: ExpansionSummary): string {
  const signed = (v: number): string => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  const lines = ['PAPER FLEET  (simulated — no real money)', '='.repeat(86)];
  const groups = [...new Set(rows.map((r) => r.spec.group))];
  // Totals add up each bot's own profit rather than equity minus starting
  // cash: a bot paid for from profits started with money the fleet earned,
  // and counting its $25 as fresh capital would hide that profit.
  let allPnl = 0;
  let allEquity = 0;
  let anyStarted = false;
  for (const group of groups) {
    const members = rows.filter((r) => r.spec.group === group);
    lines.push('', group.toUpperCase());
    lines.push(`  ${'bot'.padEnd(34)} ${'equity'.padStart(8)} ${'profit'.padStart(8)} ${'%'.padStart(7)} ${'trades'.padStart(6)} ${'fees'.padStart(6)}`);
    const sorted = [...members].sort((a, b) => (b.status?.pnl ?? -Infinity) - (a.status?.pnl ?? -Infinity));
    let pnl = 0;
    let equity = 0;
    let started = false;
    for (const { spec, status } of sorted) {
      const label = `${spec.strategy} ${spec.symbols.join(',')}`;
      if (!status) {
        lines.push(`  ${label.padEnd(34)} not started`);
        continue;
      }
      started = true;
      pnl += status.pnl;
      equity += status.equity;
      lines.push(
        `  ${label.padEnd(34)} ${`$${status.equity.toFixed(2)}`.padStart(8)} ${signed(status.pnl).padStart(8)} ` +
        `${`${status.pnlPct >= 0 ? '+' : ''}${status.pnlPct.toFixed(1)}%`.padStart(7)} ` +
        `${String(status.buys + status.sells).padStart(6)} ${`$${status.feesPaid.toFixed(2)}`.padStart(6)}` +
        `${spec.strategy === 'coin-flip' ? '  <- luck control' : ''}${status.killed ? '  HALTED' : ''}`,
      );
    }
    allPnl += pnl;
    allEquity += equity;
    anyStarted ||= started;
    if (started) lines.push(`  ${'group total'.padEnd(34)} ${`$${equity.toFixed(2)}`.padStart(8)} ${signed(pnl).padStart(8)}`);
  }
  if (anyStarted) {
    lines.push('', `ALL BOTS  $${allEquity.toFixed(2)} now, profit ${signed(allPnl)}`);
  }
  if (expansion) {
    lines.push(
      '',
      `EXPANSION  ${expansion.added} bot${expansion.added === 1 ? '' : 's'} added from profits, ${expansion.queued} queued. ` +
      `Fleet profit ${signed(expansion.profit)}` +
      (expansion.queued > 0
        ? `; the next bot needs ${expansion.needed > 0 ? `$${expansion.needed.toFixed(2)} more profit` : 'only for that profit to be banked in cash'}.`
        : '.'),
    );
  }
  lines.push(
    '',
    'With this many bots, the best one is often lucky. A bot has shown something only if it',
    'beats its group\'s coin-flip control — and keeps beating it for weeks, not hours.',
  );
  return lines.join('\n');
}
