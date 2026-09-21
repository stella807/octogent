import type { Trade } from '../domain/types.ts';

/**
 * Resample the realised trades to ask the question a single backtest cannot:
 * how much of that equity curve was the ORDER the trades happened to arrive in?
 *
 * One backtest is one sample path. Reshuffle the same trades and the same
 * strategy can show a 12% drawdown or a 40% one purely by luck of sequencing.
 * `probabilityOfLoss` here is the direct, quantified refutation of "0% losses":
 * run it on any strategy in this repo and the number is never zero.
 */
export interface MonteCarloOptions {
  readonly runs: number;
  readonly seed: number;
  /** Drawdown percent treated as account death, for the ruin estimate. */
  readonly ruinDrawdownPct: number;
}

export const DEFAULT_MC_OPTIONS: MonteCarloOptions = {
  runs: 2000,
  seed: 20260921,
  ruinDrawdownPct: 50,
};

export interface Percentiles {
  readonly p5: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p95: number;
}

export interface MonteCarloResult {
  readonly runs: number;
  readonly tradesPerRun: number;
  readonly finalEquity: Percentiles & { readonly worst: number; readonly best: number };
  readonly maxDrawdownPct: Percentiles & { readonly worst: number };
  /** Fraction of resampled paths that finish below the starting equity. */
  readonly probabilityOfLoss: number;
  /** Fraction of paths whose drawdown reaches `ruinDrawdownPct`. */
  readonly probabilityOfRuin: number;
}

export function monteCarlo(
  trades: readonly Trade[],
  startingEquity: number,
  options: MonteCarloOptions = DEFAULT_MC_OPTIONS,
): MonteCarloResult {
  if (trades.length < 2) {
    throw new RangeError(
      `monte carlo needs at least 2 trades to resample, got ${trades.length}`,
    );
  }
  if (startingEquity <= 0) throw new RangeError('startingEquity must be > 0');

  const random = mulberry32(options.seed);
  // Resample each trade's return on TOTAL EQUITY, not its return on the
  // capital committed to it. Compounding the latter silently assumes every
  // trade was the whole account, which inflates both the upside and the
  // drawdowns by roughly the inverse of the position size.
  const tradeReturns = trades.map((t) => t.returnOnEquity);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  let losingPaths = 0;
  let ruinedPaths = 0;

  for (let run = 0; run < options.runs; run += 1) {
    let equity = startingEquity;
    let peak = startingEquity;
    let maxDd = 0;
    for (let i = 0; i < tradeReturns.length; i += 1) {
      const pick = tradeReturns[Math.floor(random() * tradeReturns.length)] ?? 0;
      equity *= 1 + pick;
      if (equity <= 0) {
        equity = 0;
        maxDd = 100;
        break;
      }
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
    finals.push(equity);
    drawdowns.push(maxDd);
    if (equity < startingEquity) losingPaths += 1;
    if (maxDd >= options.ruinDrawdownPct) ruinedPaths += 1;
  }

  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);

  return {
    runs: options.runs,
    tradesPerRun: trades.length,
    finalEquity: {
      ...percentiles(finals),
      worst: finals[0] as number,
      best: finals[finals.length - 1] as number,
    },
    maxDrawdownPct: {
      ...percentiles(drawdowns),
      worst: drawdowns[drawdowns.length - 1] as number,
    },
    probabilityOfLoss: losingPaths / options.runs,
    probabilityOfRuin: ruinedPaths / options.runs,
  };
}

function percentiles(sorted: readonly number[]): Percentiles {
  return {
    p5: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
  };
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

/** Seeded PRNG so every reported Monte Carlo number is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
