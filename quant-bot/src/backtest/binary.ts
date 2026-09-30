import type { Candle } from '../domain/types.ts';
import { mulberry32 } from './monte-carlo.ts';

export type Call = 'up' | 'down';

export interface BinaryOptions {
  /** Bars until a bet settles. */
  readonly expiryBars: number;
  /** Profit on a winning bet as a fraction of the stake; 0.8 pays $0.80 per $1. */
  readonly payout: number;
  /** Stake per bet as a fraction of current equity. */
  readonly stakePct: number;
  /** Smallest bet the venue takes; below this the account is finished. */
  readonly minStake: number;
  readonly startingEquity: number;
}

export const DEFAULT_BINARY: BinaryOptions = {
  expiryBars: 1,
  payout: 0.8,
  stakePct: 0.02,
  minStake: 1,
  startingEquity: 25,
};

export interface BinaryBet {
  readonly t: number;
  readonly call: Call;
  readonly strike: number;
  readonly settle: number;
  readonly outcome: 'win' | 'loss' | 'push';
  readonly stake: number;
  readonly pnl: number;
}

export interface BinaryResult {
  readonly bets: readonly BinaryBet[];
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  /** Wins over decided bets; pushes are refunded and count for neither side. */
  readonly hitRate: number;
  readonly breakevenHitRate: number;
  /** How many standard errors the hit rate sits above breakeven; below 2 is indistinguishable from luck. */
  readonly tStatVsBreakeven: number;
  /** Net profit per dollar staked. */
  readonly returnPerDollar: number;
  readonly finalEquity: number;
  readonly returnPct: number;
  readonly maxDrawdownPct: number;
  readonly busted: boolean;
  /** Bars from the first bar to the last settlement: how long the account survived. */
  readonly barsLasted: number;
}

/**
 * A win pays `payout` per dollar and a loss costs the dollar, so the bet only
 * breaks even at p·payout = (1 − p). At the typical 80% payout that is 55.6%:
 * a signal has to beat a coin flip by more than five points just to stand still.
 */
export function breakevenHitRate(payout: number): number {
  return 1 / (1 + payout);
}

/**
 * Bets are placed at the close of bar t, struck at that close and settled at
 * the close `expiryBars` later. `predict(t)` must only read candles[0..t];
 * the next bet opens when the previous one settles, so stakes never overlap
 * and every bet is sized from equity that has actually been realized.
 */
export function runBinary(
  candles: readonly Candle[],
  predict: (t: number) => Call | null,
  options: BinaryOptions,
): BinaryResult {
  validate(options);
  const bets: BinaryBet[] = [];
  let equity = options.startingEquity;
  let peak = equity;
  let maxDrawdown = 0;
  let busted = false;
  let t = 0;
  while (t + options.expiryBars < candles.length) {
    const call = predict(t);
    if (call === null) {
      t += 1;
      continue;
    }
    const stake = Math.min(equity, Math.max(options.minStake, equity * options.stakePct));
    if (equity < options.minStake) {
      busted = true;
      break;
    }
    const strike = (candles[t] as Candle).close;
    const settle = (candles[t + options.expiryBars] as Candle).close;
    const outcome = settle === strike ? 'push' : (settle > strike) === (call === 'up') ? 'win' : 'loss';
    const pnl = outcome === 'win' ? stake * options.payout : outcome === 'loss' ? -stake : 0;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? 1 - equity / peak : 0);
    bets.push({ t, call, strike, settle, outcome, stake, pnl });
    t += options.expiryBars;
  }
  if (equity < options.minStake) busted = true;

  const wins = bets.filter((b) => b.outcome === 'win').length;
  const losses = bets.filter((b) => b.outcome === 'loss').length;
  const decided = wins + losses;
  const hitRate = decided > 0 ? wins / decided : 0;
  const breakeven = breakevenHitRate(options.payout);
  const staked = bets.reduce((sum, b) => sum + b.stake, 0);
  return {
    bets,
    wins,
    losses,
    pushes: bets.length - decided,
    hitRate,
    breakevenHitRate: breakeven,
    tStatVsBreakeven: decided > 0 ? (hitRate - breakeven) / Math.sqrt((breakeven * (1 - breakeven)) / decided) : 0,
    returnPerDollar: staked > 0 ? bets.reduce((sum, b) => sum + b.pnl, 0) / staked : 0,
    finalEquity: equity,
    returnPct: (equity / options.startingEquity - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    busted,
    barsLasted: bets.length > 0 ? (bets[bets.length - 1] as BinaryBet).t + options.expiryBars : 0,
  };
}

/** A seeded coin flip: the no-skill baseline every signal has to beat. */
export function coinFlip(seed: number): (t: number) => Call {
  const rand = mulberry32(seed);
  return () => (rand() < 0.5 ? 'up' : 'down');
}

function validate(o: BinaryOptions): void {
  if (!Number.isInteger(o.expiryBars) || o.expiryBars < 1) throw new RangeError('expiry must be a whole number of bars, at least 1');
  if (!(o.payout > 0)) throw new RangeError('payout must be positive');
  if (!(o.stakePct > 0 && o.stakePct <= 1)) throw new RangeError('stake must be between 0 and 100% of equity');
  if (!(o.startingEquity > 0)) throw new RangeError('starting equity must be positive');
}

export function formatBinary(
  rows: readonly { readonly label: string; readonly result: BinaryResult }[],
  options: BinaryOptions,
  symbol: string,
  timeframe: string,
): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const money = (v: number): string => `$${v.toFixed(2)}`;
  const breakeven = breakevenHitRate(options.payout);
  const lines = [
    `BINARY OPTIONS  ${symbol}  expiry ${options.expiryBars} × ${timeframe}  payout ${pct(options.payout)}  ` +
    `stake ${pct(options.stakePct)} of equity  (simulated on past prices)`,
    '================================================================',
    `  A win pays ${money(options.payout)} per $1; a loss costs the $1. Breakeven hit rate: ${pct(breakeven)}.`,
    '',
    `  ${'signal'.padEnd(18)} ${'bets'.padStart(6)} ${'hit rate'.padStart(9)} ${'t vs b/e'.padStart(9)} ` +
    `${'per $1'.padStart(8)} ${'final'.padStart(10)} ${'max DD'.padStart(7)} ${'lasted'.padStart(10)}`,
  ];
  for (const { label, result: r } of rows) {
    lines.push(
      `  ${label.padEnd(18)} ${String(r.bets.length).padStart(6)} ${pct(r.hitRate).padStart(9)} ` +
      `${r.tStatVsBreakeven.toFixed(2).padStart(9)} ${`${r.returnPerDollar >= 0 ? '+' : ''}${(r.returnPerDollar * 100).toFixed(1)}¢`.padStart(8)} ` +
      `${money(r.finalEquity).padStart(10)} ${`${r.maxDrawdownPct.toFixed(0)}%`.padStart(7)} ` +
      `${`${r.barsLasted} bars`.padStart(10)}${r.busted ? '  BUSTED' : ''}`,
    );
  }
  const best = rows.reduce<BinaryResult | null>((b, r) => (b === null || r.result.tStatVsBreakeven > b.tStatVsBreakeven ? r.result : b), null);
  lines.push(
    '',
    best !== null && best.tStatVsBreakeven >= 2
      ? '  One signal clears breakeven by 2+ standard errors here. Confirm it on other markets and\n' +
        '  periods before believing it: with several signals tried, one will sometimes look good by luck.'
      : `  No signal beats the ${pct(breakeven)} breakeven by a margin luck can't explain. At this payout,\n` +
        '  every bet costs money on average; the house edge is the gap between 50% and breakeven.',
  );
  return lines.join('\n');
}
