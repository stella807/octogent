/**
 * Trading costs, charged on both sides of every round trip.
 *
 * These defaults are deliberately pessimistic rather than optimistic. A
 * backtest run at zero fees is the single easiest way to manufacture a
 * profitable-looking strategy that loses money the moment it goes live: a
 * system trading daily bars pays the round trip maybe 30 times a year, but an
 * intraday one pays it thousands of times, and at 0.15% a side that is the
 * entire edge.
 */
export interface CostModel {
  /** Taker fee per side, in basis points. 10 bps = 0.10%, typical spot taker. */
  readonly feeBps: number;
  /** Adverse price movement per side, in basis points. */
  readonly slippageBps: number;
  /**
   * Smallest order the exchange will accept, in quote currency.
   *
   * Without this a backtest cheerfully buys $0.48 of BTC and reports a tidy
   * return on it. A real exchange rejects the order, so a small account does
   * not underperform the backtest — it never trades at all. Coinbase Advanced
   * is around $1, Binance around $5-10, Kraken varies by pair.
   */
  readonly minOrderNotional: number;
}

/** Binance-style spot taker fees plus a conservative slippage allowance. */
export const DEFAULT_COSTS: CostModel = { feeBps: 10, slippageBps: 5, minOrderNotional: 1 };

/** Zero-cost model. Only for unit tests that isolate engine mechanics. */
export const FRICTIONLESS: CostModel = { feeBps: 0, slippageBps: 0, minOrderNotional: 0 };

const BPS = 10_000;

/** A buy fills worse (higher) than the quoted price. */
export function buyFillPrice(price: number, costs: CostModel): number {
  return price * (1 + costs.slippageBps / BPS);
}

/** A sell fills worse (lower) than the quoted price. */
export function sellFillPrice(price: number, costs: CostModel): number {
  return price * (1 - costs.slippageBps / BPS);
}

export function feeOn(notional: number, costs: CostModel): number {
  return Math.abs(notional) * (costs.feeBps / BPS);
}

/**
 * Round-trip cost as a fraction of notional. Compare this against a strategy's
 * average winning trade: if the gap is small, the strategy is a fee pump.
 */
export function roundTripCost(costs: CostModel): number {
  return (2 * (costs.feeBps + costs.slippageBps)) / BPS;
}

/**
 * Smallest account that can actually place a compliant order.
 *
 * Risk-based sizing means the position is a fraction of equity, so below some
 * balance that fraction falls under the exchange minimum and every order is
 * rejected. The honest answer to "can I start with $5" is arithmetic, not
 * opinion: at 1% risk with a 10% stop distance the position is 10% of equity,
 * so $1 minimum order needs roughly $10 — and needs far more than that before
 * the position is big enough for the returns to mean anything.
 *
 * `stopDistancePct` is how far the stop sits below entry, as a percent of
 * price. Around 10% is typical for a 2.5x ATR stop on BTC daily bars.
 */
export function minimumViableEquity(
  costs: CostModel,
  riskPerTradePct: number,
  maxPositionPct: number,
  stopDistancePct: number,
): number {
  if (costs.minOrderNotional <= 0) return 0;
  const byRisk = stopDistancePct > 0 ? riskPerTradePct / stopDistancePct : 1;
  const fraction = Math.min(maxPositionPct / 100, byRisk);
  return fraction > 0 ? costs.minOrderNotional / fraction : Infinity;
}
