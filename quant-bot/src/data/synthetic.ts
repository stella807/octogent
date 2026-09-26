import { mulberry32 } from "../backtest/monte-carlo.ts";
import { type Candle, TIMEFRAME_MS, type Timeframe } from "../domain/types.ts";

export interface SyntheticOptions {
  readonly bars: number;
  readonly timeframe?: Timeframe;
  readonly seed?: number;
  /** Open time of the first bar, epoch ms. */
  readonly startTime?: number;
  readonly startPrice?: number;
}

interface Regime {
  /** Mean log return per day. */
  readonly drift: number;
  /** Standard deviation of log return per day. */
  readonly vol: number;
  /** Mean length of the regime in days before it flips. */
  readonly meanDays: number;
}

/**
 * A slow bull and a steeper bear. The bear regime is the point: a generator
 * that only drifts up rewards every long-only strategy and hides the ones that
 * blow up the first time the market turns. Bears fall twice as fast as bulls
 * rise, so a long sample tends to contain at least one deep drawdown.
 *
 * Volatility is deliberately below real BTC (~3%/day) so drift is visible
 * against noise within a regime; the fat-tailed shocks below supply the crash
 * days that a lower vol would otherwise remove.
 */
const REGIMES: readonly Regime[] = [
  { drift: 0.0015, vol: 0.015, meanDays: 300 },
  { drift: -0.003, vol: 0.015, meanDays: 200 },
];

/**
 * Degrees of freedom for the Student-t shocks. Normal shocks almost never
 * produce the multi-sigma crash days crypto actually has, and those days are
 * exactly what wide-stop strategies are exposed to.
 */
const TAIL_DOF = 4;

const DEFAULT_START = Date.UTC(2018, 0, 1);

/**
 * Seeded regime-switching geometric Brownian motion, so the suite and
 * `--synthetic` smoke runs work offline and reproducibly.
 *
 * Within a regime, returns are GBM and therefore have no mean reversion: a
 * mean-reversion strategy barely trades on this data, which is honest, not a
 * bug. Each bar opens at the previous close, so there are no gaps for stops to
 * jump over that a real 24/7 market would not have.
 */
export function generateCandles(options: SyntheticOptions): Candle[] {
  const timeframe = options.timeframe ?? "1d";
  const barMs = TIMEFRAME_MS[timeframe];
  const days = barMs / TIMEFRAME_MS["1d"];
  const random = mulberry32(options.seed ?? 42);
  const normal = (): number => {
    // Box-Muller; 1 - u keeps log() away from zero.
    const u = 1 - random();
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // Student-t scaled to unit variance: normal / sqrt(chi-squared / dof).
  const shock = (): number => {
    let chi2 = 0;
    for (let k = 0; k < TAIL_DOF; k += 1) chi2 += normal() ** 2;
    return (normal() / Math.sqrt(chi2 / TAIL_DOF)) * Math.sqrt((TAIL_DOF - 2) / TAIL_DOF);
  };

  let regime = 0;
  let price = options.startPrice ?? 10_000;
  const start = options.startTime ?? DEFAULT_START;
  const candles: Candle[] = [];

  for (let i = 0; i < options.bars; i += 1) {
    const { meanDays } = REGIMES[regime] as Regime;
    if (random() < 1 - (1 - 1 / meanDays) ** days) regime = (regime + 1) % REGIMES.length;
    const { drift, vol } = REGIMES[regime] as Regime;
    const barVol = vol * Math.sqrt(days);

    const open = price;
    const close = open * Math.exp(drift * days - (barVol * barVol) / 2 + barVol * shock());
    // Wicks extend past the body by a half-normal fraction of the bar's vol.
    const high = Math.max(open, close) * Math.exp(Math.abs(normal()) * barVol * 0.5);
    const low = Math.min(open, close) * Math.exp(-Math.abs(normal()) * barVol * 0.5);
    const volume = 1000 * Math.exp(0.5 * normal()) * (1 + Math.abs(close / open - 1) * 20);

    candles.push({ time: start + i * barMs, open, high, low, close, volume });
    price = close;
  }
  return candles;
}
