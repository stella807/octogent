import type { EquityPoint, Timeframe, Trade } from '../domain/types.ts';
import { TIMEFRAME_MS } from '../domain/types.ts';
import type { BacktestResult } from './engine.ts';

/**
 * Performance statistics, chosen so the unflattering ones are impossible to
 * skip. `totalReturnPct` on its own is the number the reels show; it is also
 * the least informative one in here. Max drawdown, loss rate and the worst
 * losing streak are what tell you whether a human could actually have sat
 * through this equity curve without switching the bot off at the bottom.
 */
export interface Metrics {
  readonly startingEquity: number;
  readonly endingEquity: number;
  readonly totalReturnPct: number;
  readonly cagrPct: number;
  readonly maxDrawdownPct: number;
  readonly maxDrawdownDurationBars: number;
  readonly sharpe: number;
  readonly sortino: number;
  readonly calmar: number;
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRatePct: number;
  /** Deliberately reported alongside win rate. It is never zero. */
  readonly lossRatePct: number;
  readonly profitFactor: number;
  readonly expectancy: number;
  readonly avgWin: number;
  readonly avgLoss: number;
  readonly payoffRatio: number;
  readonly largestWin: number;
  readonly largestLoss: number;
  readonly maxConsecutiveLosses: number;
  readonly totalFees: number;
  readonly timeInMarketPct: number;
  /** Mean position size as a percent of equity, including flat bars. */
  readonly avgExposurePct: number;
  readonly stoppedOutCount: number;
}

export function computeMetrics(result: BacktestResult): Metrics {
  const { equityCurve, trades, startingEquity, endingEquity } = result;
  const barMs = TIMEFRAME_MS[result.config.timeframe];
  const barsPerYear = (365 * 86_400_000) / barMs;

  const returns = barReturns(equityCurve);
  const { maxDrawdownPct, maxDrawdownDurationBars } = drawdown(equityCurve);

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  const totalReturnPct = ((endingEquity - startingEquity) / startingEquity) * 100;
  const years = equityCurve.length > 0 ? equityCurve.length / barsPerYear : 0;
  const cagrPct = years > 0 && startingEquity > 0 && endingEquity > 0
    ? ((endingEquity / startingEquity) ** (1 / years) - 1) * 100
    : 0;

  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

  const inMarket = equityCurve.filter((p) => p.exposure > 0).length;
  const exposureSum = equityCurve.reduce((a, p) => a + p.exposure, 0);

  return {
    startingEquity,
    endingEquity,
    totalReturnPct,
    cagrPct,
    maxDrawdownPct,
    maxDrawdownDurationBars,
    sharpe: annualisedRatio(returns, barsPerYear, false),
    sortino: annualisedRatio(returns, barsPerYear, true),
    calmar: maxDrawdownPct > 0 ? cagrPct / maxDrawdownPct : 0,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    lossRatePct: trades.length > 0 ? (losses.length / trades.length) * 100 : 0,
    // Infinity here means "no losing trades in this sample", which is a sign
    // the sample is too small, not a sign the strategy cannot lose.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    expectancy: trades.length > 0 ? (grossWin - grossLoss) / trades.length : 0,
    avgWin,
    avgLoss,
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0),
    largestWin: wins.reduce((a, t) => Math.max(a, t.pnl), 0),
    largestLoss: losses.reduce((a, t) => Math.min(a, t.pnl), 0),
    maxConsecutiveLosses: maxLosingStreak(trades),
    totalFees: trades.reduce((a, t) => a + t.fees, 0),
    timeInMarketPct: equityCurve.length > 0 ? (inMarket / equityCurve.length) * 100 : 0,
    avgExposurePct: equityCurve.length > 0 ? (exposureSum / equityCurve.length) * 100 : 0,
    stoppedOutCount: trades.filter((t) => t.exitReason === 'stop').length,
  };
}

export function barReturns(curve: readonly EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const prev = (curve[i - 1] as EquityPoint).equity;
    const cur = (curve[i] as EquityPoint).equity;
    out.push(prev > 0 ? cur / prev - 1 : 0);
  }
  return out;
}

/**
 * Peak-to-trough decline and how long it took to make a new high. The duration
 * is the one that decides whether a strategy is actually tradeable: a 20%
 * drawdown that lasts three bars is noise, the same drawdown lasting eight
 * months is the reason people abandon systems at the worst possible moment.
 */
export function drawdown(curve: readonly EquityPoint[]): {
  maxDrawdownPct: number;
  maxDrawdownDurationBars: number;
} {
  let peak = Number.NEGATIVE_INFINITY;
  let peakIndex = 0;
  let maxDrawdownPct = 0;
  let maxDrawdownDurationBars = 0;
  for (let i = 0; i < curve.length; i += 1) {
    const equity = (curve[i] as EquityPoint).equity;
    if (equity > peak) {
      peak = equity;
      peakIndex = i;
    } else if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      const duration = i - peakIndex;
      if (duration > maxDrawdownDurationBars) maxDrawdownDurationBars = duration;
    }
  }
  return { maxDrawdownPct, maxDrawdownDurationBars };
}

/** Sharpe at `downsideOnly = false`, Sortino at `true`. Risk-free rate is 0. */
function annualisedRatio(
  returns: readonly number[],
  barsPerYear: number,
  downsideOnly: boolean,
): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  const sample = downsideOnly ? returns.filter((r) => r < 0) : returns;
  if (sample.length < 2) return 0;
  const variance = sample.reduce((a, r) => a + (downsideOnly ? r * r : (r - mean) ** 2), 0)
    / (sample.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(barsPerYear);
}

export function maxLosingStreak(trades: readonly Trade[]): number {
  let streak = 0;
  let worst = 0;
  for (const trade of trades) {
    if (trade.pnl <= 0) {
      streak += 1;
      if (streak > worst) worst = streak;
    } else {
      streak = 0;
    }
  }
  return worst;
}
