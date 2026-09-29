import type { Candle, Timeframe } from '../domain/types.ts';

export interface Balance {
  /** Quote currency available to spend, e.g. USDT. */
  readonly cash: number;
  /** Base currency held, e.g. BTC. */
  readonly qty: number;
}

export interface Fill {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly qty: number;
  readonly price: number;
  readonly fee: number;
  readonly time: number;
}

/**
 * An order the venue refused outright — below its minimum size, or more than
 * the account can pay for. Retrying the same order on the next poll would be
 * refused the same way, so the runner records it and moves on rather than
 * treating it like a transient network error.
 */
export class OrderRejectedError extends Error {
  override readonly name = 'OrderRejectedError';
}

/**
 * The seam between strategy logic and real money.
 *
 * Both the paper broker and the exchange broker implement it, so the runner
 * has no idea which one it is driving — which is the point. If switching to
 * live required a different code path, that code path would be the one least
 * tested and most expensive to get wrong.
 */
export interface Broker {
  readonly id: string;
  /** True only for brokers that move real funds. The runner logs this loudly. */
  readonly isLive: boolean;
  balance(symbol: string): Promise<Balance>;
  lastPrice(symbol: string): Promise<number>;
  candles(symbol: string, timeframe: Timeframe, bars: number): Promise<Candle[]>;
  marketBuy(symbol: string, quoteAmount: number): Promise<Fill>;
  marketSell(symbol: string, qty: number): Promise<Fill>;
}
