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

export interface BotLife {
  readonly bornAt: string;
  readonly validatedAt?: string;
  readonly validation?: string;
  readonly validPassed?: boolean;
  readonly luckPassed?: boolean;
  /** Set while a validator is serving out its demotion; its validator trial counts from here. */
  readonly demotedAt?: string;
  /** Which validator stint this is; each gets a fresh validator-money account. */
  readonly shadowRound?: number;
  /** Which stint of real trading this is; each gets a fresh account funded by the fleet. */
  readonly generation?: number;
}

export interface DeadBot {
  readonly name: string;
  readonly at: string;
  readonly reason: string;
  /** Cash it handed back to the treasury after selling what it held. */
  readonly returned: number;
}

export interface FleetFile {
  readonly exchange: string;
  readonly createdAt: string;
  readonly bots: readonly BotSpec[];
  /** Bots waiting to be added, in order, once profits can pay for them. */
  readonly reserve?: readonly BotSpec[];
  readonly added?: readonly FundedBot[];
  /** The fleet's starting money; profit is measured against it. */
  readonly budget?: number;
  /** Cash returned by bots that died, waiting to fund replacements. */
  readonly treasury?: number;
  readonly life?: Readonly<Record<string, BotLife>>;
  readonly dead?: readonly DeadBot[];
  /** Queued bots whose strategy failed validation before they ever traded. */
  readonly rejected?: readonly { readonly name: string; readonly reason: string }[];
  /**
   * Bots without money: demoted traders and candidates not yet worthy. They
   * keep trading with validator money (not counted in the fleet), vote on
   * other bots' strategies with their markets, and can be promoted back.
   */
  readonly validators?: readonly BotSpec[];
  /** The fleet's latest verdict per strategy@timeframe. */
  readonly consensus?: Readonly<Record<string, Consensus & { readonly at: string }>>;
}

/**
 * Yardsticks, not contestants: the coin flip measures luck and buy-and-hold
 * measures the market. They are exempt from validation and never die,
 * because the survival rules judge every other bot against them.
 */
const CONTROLS = new Set(['coin-flip', 'buy-and-hold']);

export function isControl(strategy: string): boolean {
  return CONTROLS.has(strategy);
}

const DAY_MS = 86_400_000;

/**
 * How long a bot trades before its results can kill it. Days of P&L are
 * mostly luck (a quarter of coin flips are up after any given week), so a
 * daily bot gets a month and a one-minute bot, with ~1,440 decisions a day,
 * gets a day.
 */
export const TRIAL_MS: Readonly<Record<string, number>> = { '1m': DAY_MS, '1d': 30 * DAY_MS };

function trialFor(timeframe: Timeframe): number {
  return TRIAL_MS[timeframe] ?? 30 * TIMEFRAME_MS[timeframe];
}

/** How often a living bot's strategy is re-validated against the latest data. */
export const REVALIDATE_MS = DAY_MS;

export interface Validation {
  readonly passed: boolean;
  /** Whether the same strategy also passed on its market's bars shuffled into random order. */
  readonly luckPassed: boolean;
  readonly reason: string;
}

export interface Contestant {
  readonly spec: BotSpec;
  readonly status: PaperStatus;
  readonly ageMs: number;
  /** Latest walk-forward verdict on its own market; null if not checked this round. */
  readonly validation: Validation | null;
}

/** P(X >= k) for X ~ Binomial(n, p): the chance luck alone produces k or more passes. */
export function binomialTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  let tail = 0;
  let coeff = 1;
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) coeff = (coeff * (n - i + 1)) / i;
    if (i >= k) tail += coeff * p ** i * (1 - p) ** (n - i);
  }
  return Math.min(1, tail);
}

export interface Vote {
  /** The voter's market; each market votes once. */
  readonly market: string;
  /** The candidate's strategy passed walk-forward on this market. */
  readonly passed: boolean;
  /** It also passed on this market's shuffled bars: what luck looks like here. */
  readonly luckPassed: boolean;
}

export interface Consensus {
  readonly approved: boolean;
  readonly passes: number;
  readonly voters: number;
  readonly luckRate: number;
  /** Chance luck alone would give this many passes. */
  readonly pValue: number;
}

/** Fewer markets than this cannot tell a good strategy from a lucky one. */
const QUORUM = 3;
/** Luck is never assumed rarer than this, even if no shuffled market happened to pass. */
const LUCK_FLOOR = 0.05;
const SIGNIFICANCE = 0.05;

/**
 * The fleet's verdict on a strategy. Every bot tests it on its own market,
 * and on that market shuffled into random order. A strategy is worthy when it
 * passes on more real markets than luck can explain — the shuffled pass rate
 * is luck's rate — at 5% significance. One lucky coin cannot pass this; a
 * strategy that works across markets can.
 */
export function consensusVerdict(votes: readonly Vote[]): Consensus {
  const byMarket = new Map<string, Vote>();
  for (const v of votes) if (!byMarket.has(v.market)) byMarket.set(v.market, v);
  const counted = [...byMarket.values()];
  const voters = counted.length;
  const passes = counted.filter((v) => v.passed).length;
  const luckRate = voters > 0 ? Math.max(LUCK_FLOOR, counted.filter((v) => v.luckPassed).length / voters) : 1;
  const pValue = binomialTail(passes, voters, luckRate);
  return { approved: voters >= QUORUM && passes >= 2 && pValue < SIGNIFICANCE, passes, voters, luckRate, pValue };
}

export function describeConsensus(c: Consensus): string {
  return `${c.passes} of ${c.voters} markets (luck would do this ${(c.pValue * 100).toFixed(1)}% of the time)`;
}

/**
 * Why a trader is demoted to validator now, or null if it keeps trading.
 * Controls never are: the coin flip and buy-and-hold are the yardsticks.
 */
export function demotionReason(bot: Contestant, controlPnlPct: number | null, consensus: Consensus | null): string | null {
  if (isControl(bot.spec.strategy)) return null;
  if (bot.validation && !bot.validation.passed) return `failed validation: ${bot.validation.reason}`;
  if (bot.validation?.luckPassed) return 'passes on shuffled prices too: its pass was luck, not skill';
  if (consensus && !consensus.approved) return `lost the fleet's consensus: ${describeConsensus(consensus)}`;
  if (bot.status.killed) return `kill switch tripped: ${bot.status.killReason ?? 'unknown'}`;
  if (bot.status.equity < minEquityFor(bot.spec)) {
    return `too small to trade: $${bot.status.equity.toFixed(2)} is under what its orders need`;
  }
  if (bot.ageMs >= trialFor(bot.spec.timeframe) && bot.status.pnl < 0) {
    const flip = controlPnlPct === null ? '' : ` (coin flip: ${controlPnlPct.toFixed(1)}%)`;
    return `not making money after its trial: ${bot.status.pnlPct.toFixed(1)}%${flip}`;
  }
  return null;
}

/**
 * Whether a validator (or a queued candidate) is worthy of real money. It
 * must validate on its own market without the pass being luck, and win the
 * fleet's consensus. A demoted bot must also have made money with validator
 * money over a full trial since it was demoted: it lost once, so its word
 * alone is not enough.
 */
export function promotionVerdict(input: {
  readonly validation: Validation | null;
  readonly consensus: Consensus | null;
  readonly demoted: boolean;
  readonly shadow: { readonly pnl: number; readonly ageMs: number } | null;
  readonly trialMs?: number;
}): { promote: boolean; reason: string } {
  const { validation, consensus } = input;
  if (!validation) return { promote: false, reason: 'not validated yet' };
  if (!validation.passed) return { promote: false, reason: `fails validation: ${validation.reason}` };
  if (validation.luckPassed) return { promote: false, reason: 'passes on shuffled prices too: luck' };
  if (!consensus?.approved) {
    return { promote: false, reason: consensus ? `no consensus: ${describeConsensus(consensus)}` : 'no consensus yet' };
  }
  if (input.demoted) {
    const trial = input.trialMs ?? (TRIAL_MS['1d'] as number);
    if (!input.shadow || input.shadow.ageMs < trial) return { promote: false, reason: 'still in its validator trial' };
    if (input.shadow.pnl <= 0) return { promote: false, reason: 'its validator record is not profitable' };
  }
  return { promote: true, reason: `${validation.reason}; consensus ${describeConsensus(consensus)}` };
}

/** Each bot's account when no budget is given: ten bots, $250 in all. */
export const DEFAULT_BOT_EQUITY = 25;

/**
 * Smallest account at which a strategy's smallest-ever entry still clears
 * the exchange's $1 minimum order, measured from its trades over ~8 years of
 * Coinbase BTC. Stop-sized strategies commit only a slice of the account per
 * trade (daily donchian's smallest was 5.5%, ema-zone-reversal's 3.1%), so a
 * small account makes every order too small to place. Anything not listed
 * commits the whole account per trade and needs only the minimum plus fees.
 */
export const MIN_EQUITY: Readonly<Record<string, number>> = {
  'donchian-breakout@1d': 19,
  'ema-zone-reversal@1d': 33,
  'dca-safety@1d': 29,
};
const FULL_POSITION_MIN = 1.01;

export function minEquityFor(spec: Pick<BotSpec, 'strategy' | 'timeframe'>): number {
  return MIN_EQUITY[`${spec.strategy}@${spec.timeframe}`] ?? FULL_POSITION_MIN;
}

function canTrade(spec: BotSpec): boolean {
  return minEquityFor(spec) <= spec.equity;
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

function bot(group: string, prefix: string, strategy: string, symbol: string, timeframe: Timeframe, equity: number): BotSpec {
  return {
    name: `${prefix}-${strategy}-${slug(symbol)}`,
    group,
    strategy,
    symbols: [symbol],
    timeframe,
    equity,
    feeBps: FEE_BPS,
    maxDrawdownPct: maxDrawdownFor(strategy),
  };
}

export function planFleet(topCoins: readonly string[], equity: number = DEFAULT_BOT_EQUITY): BotSpec[] {
  return [
    ...DAILY_STRATEGIES.flatMap((s) => DAILY_SYMBOLS.map((sym) => bot('daily strategies', 'daily', s, sym, '1d', equity))),
    ...topCoins.map((sym) => bot('trend-hold x32', 'top', 'trend-hold', sym, '1d', equity)),
    ...FAST_STRATEGIES.flatMap((s) => FAST_SYMBOLS.map((sym) => bot('fast (1-minute)', 'fast', s, sym, '1m', equity))),
  ];
}

/**
 * Ten bots: the strategies with the best evidence, one benchmark and one
 * coin-flip control per speed, so each group can still be judged against luck.
 * Names match the full fleet's, so a bot kept from it keeps its account.
 * On a small budget, a bot whose smallest trade would fall under the $1
 * minimum is swapped for the next candidate that can actually trade.
 */
export function planCoreFleet(equity: number = DEFAULT_BOT_EQUITY): BotSpec[] {
  const daily = 'daily strategies';
  const fast = 'fast (1-minute)';
  const candidates = [
    bot(daily, 'daily', 'trend-hold', 'BTC/USD', '1d', equity),
    bot(daily, 'daily', 'trend-hold', 'ETH/USD', '1d', equity),
    bot(daily, 'daily', 'donchian-breakout', 'BTC/USD', '1d', equity),
    bot(daily, 'daily', 'ema-zone-reversal', 'BTC/USD', '1d', equity),
    bot(daily, 'daily', 'buy-and-hold', 'BTC/USD', '1d', equity),
    bot(daily, 'daily', 'coin-flip', 'BTC/USD', '1d', equity),
    bot(fast, 'fast', 'donchian-breakout', 'BTC/USD', '1m', equity),
    bot(fast, 'fast', 'ema-crossover', 'BTC/USD', '1m', equity),
    bot(fast, 'fast', 'tsmom', 'BTC/USD', '1m', equity),
    bot(fast, 'fast', 'coin-flip', 'BTC/USD', '1m', equity),
    // Stand-ins for bots too small to trade: the ETH benchmark for trend-hold ETH, then SOL.
    bot(daily, 'daily', 'buy-and-hold', 'ETH/USD', '1d', equity),
    bot('trend-hold x32', 'top', 'trend-hold', 'SOL/USD', '1d', equity),
  ];
  return candidates.filter(canTrade).slice(0, 10);
}

/**
 * The queue of bots to add as profits allow: every bot in the full plan not
 * already running, in the full plan's order — daily strategies, then
 * trend-hold across the most-traded coins, then the fast bots, whose record
 * so far is the weakest. Bots whose trades would fall under the exchange
 * minimum at their budget are left out (at $25, that is dca-safety).
 */
export function planReserve(full: readonly BotSpec[], running: readonly BotSpec[]): BotSpec[] {
  const taken = new Set(running.map((b) => b.name));
  const out: BotSpec[] = [];
  for (const b of full) {
    if (taken.has(b.name) || !canTrade(b) || [...running, ...out].some((r) => sameTrade(r, b))) continue;
    out.push(b);
  }
  return out;
}

/** Two bots running one strategy on one market at one speed would only ever make the same trades. */
export function sameTrade(a: BotSpec, b: BotSpec): boolean {
  return a.strategy === b.strategy && a.timeframe === b.timeframe
    && a.symbols.length === b.symbols.length && a.symbols.every((s, i) => s === b.symbols[i]);
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
  fleet: {
    readonly principal: number;
    readonly added: number;
    readonly cost: number;
    /** Everything the fleet owns, treasury included; defaults to the bots' equity. */
    readonly value?: number;
  },
): Record<string, number> | null {
  const value = fleet.value ?? bots.reduce((sum, b) => sum + b.equity, 0);
  if (value - fleet.principal < fleet.cost * (fleet.added + 1)) return null;
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
  const validatorSpecs = Array.isArray(raw.validators) ? (raw.validators as BotSpec[]) : [];
  for (const b of [...(raw.bots as BotSpec[]), ...reserve, ...validatorSpecs]) {
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
    ...(typeof raw.budget === 'number' ? { budget: raw.budget } : {}),
    treasury: typeof raw.treasury === 'number' ? raw.treasury : 0,
    life: raw.life ?? {},
    dead: Array.isArray(raw.dead) ? raw.dead : [],
    rejected: Array.isArray(raw.rejected) ? raw.rejected : [],
    validators: Array.isArray(raw.validators) ? (raw.validators as BotSpec[]) : [],
    consensus: raw.consensus ?? {},
  };
}

/** A bot's trading account; each new stint of real trading starts a fresh one. */
export function botStatePath(fleetDir: string, name: string, generation = 1): string {
  return generation > 1
    ? join(fleetDir, name, `gen-${generation}`, 'runner-state.json')
    : join(fleetDir, name, 'runner-state.json');
}

/** A validator's account of validator money, fresh for each stint as a validator. */
export function shadowStatePath(fleetDir: string, name: string, round: number): string {
  return join(fleetDir, name, `validator-${round}`, 'runner-state.json');
}

export interface FleetRow {
  readonly spec: BotSpec;
  /** Null until the bot has written its account. */
  readonly status: PaperStatus | null;
}

export interface ValidatorRow {
  readonly spec: BotSpec;
  /** Its validator-money account; null before its first poll. */
  readonly shadow: PaperStatus | null;
  readonly demoted: boolean;
  /** Why it is not trading real money right now. */
  readonly note: string;
}

export interface ExpansionSummary {
  readonly added: number;
  readonly queued: number;
  readonly profit: number;
  readonly needed: number;
  readonly treasury?: number;
  readonly dead?: readonly DeadBot[];
  readonly rejected?: number;
  readonly validators?: readonly ValidatorRow[];
  readonly consensus?: Readonly<Record<string, Consensus>>;
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
  if (expansion) {
    // Measured against the budget, so dead bots' losses still count.
    const treasury = expansion.treasury ?? 0;
    lines.push('', `ALL BOTS  $${(allEquity + treasury).toFixed(2)} now` +
      (treasury > 0 ? ` ($${allEquity.toFixed(2)} in bots + $${treasury.toFixed(2)} treasury)` : '') +
      `, profit ${signed(expansion.profit)}`);
  } else if (anyStarted) {
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
  if (expansion?.validators?.length) {
    lines.push('', `VALIDATORS  (validator money, not counted above; they vote, and trade again once the fleet deems them worthy)`);
    for (const v of expansion.validators) {
      const record = v.shadow ? `${signed(v.shadow.pnl)}`.padStart(8) : 'starting'.padStart(8);
      lines.push(`  ${`${v.spec.strategy} ${v.spec.symbols.join(',')} ${v.spec.timeframe}`.padEnd(34)} ${record}  ${v.demoted ? 'demoted: ' : ''}${v.note}`);
    }
  }
  if (expansion?.consensus && Object.keys(expansion.consensus).length > 0) {
    lines.push('', 'CONSENSUS  (each strategy tested on every bot\'s market, against the shuffled-price luck rate)');
    for (const [key, c] of Object.entries(expansion.consensus)) {
      lines.push(`  ${key.padEnd(24)} ${c.approved ? 'WORTHY' : 'not worthy'}: ${describeConsensus(c)}`);
    }
  }
  if (expansion && (expansion.dead?.length || expansion.treasury)) {
    lines.push('', `TREASURY  $${(expansion.treasury ?? 0).toFixed(2)} returned by demoted bots, waiting to fund promotions`);
    for (const d of (expansion.dead ?? []).slice(-10)) {
      lines.push(`  ↓ ${d.name.padEnd(32)} ${d.reason}`);
    }
  }
  lines.push(
    '',
    'With this many bots, the best one is often lucky. A bot has shown something only if it',
    'beats its group\'s coin-flip control — and keeps beating it for weeks, not hours.',
  );
  return lines.join('\n');
}
