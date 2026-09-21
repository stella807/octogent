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
}

/** Binance-style spot taker fees plus a conservative slippage allowance. */
export const DEFAULT_COSTS: CostModel = { feeBps: 10, slippageBps: 5 };

/** Zero-cost model. Only for unit tests that isolate engine mechanics. */
export const FRICTIONLESS: CostModel = { feeBps: 0, slippageBps: 0 };

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
