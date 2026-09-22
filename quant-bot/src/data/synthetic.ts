import type { Candle, Timeframe } from '../domain/types.ts';
import { TIMEFRAME_MS } from '../domain/types.ts';
import { mulberry32 } from '../backtest/monte-carlo.ts';

export interface SyntheticOptions {
  readonly bars: number;
  readonly startPrice: number;
  readonly timeframe: Timeframe;
  readonly seed: number;
  /** Annualised volatility, e.g. 0.8 for the 80% that crypto majors live at. */
  readonly annualVol: number;
  /** Annualised drift applied inside bull regimes. */
  readonly annualDrift: number;
  readonly startTime: number;
}

export const DEFAULT_SYNTHETIC: SyntheticOptions = {
  bars: 1500,
  startPrice: 30_000,
  timeframe: '1d',
  seed: 42,
  annualVol: 0.8,
  annualDrift: 0.35,
  startTime: Date.UTC(2020, 0, 1),
};

/**
 * Regime-switching geometric Brownian motion. This exists so the test suite and
 * the demo run with no network and no API key, and so strategies are exercised
 * against bear phases rather than only the bull sample that happens to be in
 * whatever CSV someone downloaded.
 *
 * It is a sanity harness, not a market. Results here say whether the plumbing
 * is sound; they say nothing about whether a strategy has edge.
 */
export function generateCandles(options: Partial<SyntheticOptions> = {}): Candle[] {
  const opts = { ...DEFAULT_SYNTHETIC, ...options };
  const random = mulberry32(opts.seed);
  const barMs = TIMEFRAME_MS[opts.timeframe];
  const barsPerYear = (365 * 86_400_000) / barMs;
  const vol = opts.annualVol / Math.sqrt(barsPerYear);

  const candles: Candle[] = [];
  let price = opts.startPrice;
  let bullish = true;
  let regimeLeft = 120;

  for (let i = 0; i < opts.bars; i += 1) {
    if (regimeLeft <= 0) {
      bullish = !bullish;
      regimeLeft = 60 + Math.floor(random() * 180);
    }
    regimeLeft -= 1;

    const drift = (bullish ? opts.annualDrift : -opts.annualDrift * 0.8) / barsPerYear;
    const shock = gaussian(random) * vol;
    const open = price;
    const close = Math.max(open * Math.exp(drift - 0.5 * vol * vol + shock), 0.01);
    const wick = Math.abs(gaussian(random)) * vol * open * 0.6;
    candles.push({
      time: opts.startTime + i * barMs,
      open,
      high: Math.max(open, close) + wick,
      low: Math.max(Math.min(open, close) - wick, 0.005),
      close,
      volume: 100 + random() * 900,
    });
    price = close;
  }
  return candles;
}

/** Box-Muller, so the tails are normal rather than the flat tails of `random()`. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
