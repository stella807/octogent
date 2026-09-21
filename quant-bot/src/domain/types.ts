/**
 * Core domain vocabulary. Everything here is a plain value type: no exchange
 * clients, no filesystem, no clocks. The backtester and the live runner both
 * speak these types, which is what makes "the paper run and the backtest agree"
 * a property we can actually test rather than hope for.
 */

/** One closed OHLCV bar. `time` is the bar's OPEN time, epoch milliseconds. */
export interface Candle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

/** Milliseconds per bar, used to annualise risk metrics and to detect gaps. */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/**
 * Target exposure as a fraction of equity, in [0, 1].
 *
 * Spot-only by design: there is no short side and no leverage, so the worst
 * case on any single position is bounded by the position itself. Adding
 * leverage would mean adding liquidation handling, and an unliquidatable
 * account is the single biggest edge a small trader has.
 */
export type Exposure = number;

export interface Signal {
  /** Desired exposure after this bar closes, in [0, 1]. */
  readonly target: Exposure;
  /**
   * Protective stop for the position, as an absolute price. The engine treats
   * it as a resting order and fills it intrabar, so it is the one place where
   * a backtest is allowed to act on the low of a bar it is "inside".
   */
  readonly stopPrice?: number | undefined;
  /** Free-text reason, surfaced in trade logs so results stay explainable. */
  readonly reason?: string | undefined;
}

export const FLAT: Signal = { target: 0 };

export interface Position {
  readonly qty: number;
  readonly entryPrice: number;
  readonly entryTime: number;
  readonly stopPrice: number | undefined;
  /** Highest close seen while the position was open, for trailing stops. */
  readonly highWaterPrice: number;
}

export type ExitReason =
  | 'signal'
  | 'stop'
  | 'risk-halt'
  | 'end-of-data';

export interface Trade {
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly qty: number;
  /** Net of fees and slippage, in quote currency. */
  readonly pnl: number;
  /** Net return on the capital committed to this trade. */
  readonly pnlPct: number;
  /** Account equity at the moment the position was opened. */
  readonly equityAtEntry: number;
  /**
   * P&L as a fraction of TOTAL account equity, not of the position.
   * This is the number that actually compounds, and the one resampling must
   * use: a 20% gain on a position sized at 10% of equity grows the account by
   * 2%, and conflating the two overstates both returns and drawdowns wildly.
   */
  readonly returnOnEquity: number;
  readonly fees: number;
  readonly exitReason: ExitReason;
  readonly barsHeld: number;
}

export interface EquityPoint {
  readonly time: number;
  /** Cash + mark-to-market value of any open position. */
  readonly equity: number;
  readonly exposure: Exposure;
}
