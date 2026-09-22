import type { Candle, Timeframe } from '../domain/types.ts';
import { buyFillPrice, DEFAULT_COSTS, feeOn, sellFillPrice, type CostModel } from '../backtest/costs.ts';
import type { Balance, Broker, Fill } from './broker.ts';

export interface PaperBrokerOptions {
  readonly startingCash: number;
  readonly costs: CostModel;
  /** Supplies real market data; only the fills are simulated. */
  readonly feed: (symbol: string, timeframe: Timeframe, bars: number) => Promise<Candle[]>;
}

/**
 * Simulated fills against real market data, using the same cost model the
 * backtester uses. Sharing that model is deliberate: if paper trading were
 * optimistic relative to the backtest, paper results would stop being evidence
 * about anything.
 *
 * This is the default execution path. Nothing in this repo touches real funds
 * unless a human passes --live and sets the confirmation environment variable.
 */
export class PaperBroker implements Broker {
  readonly id = 'paper';
  readonly isLive = false;
  readonly fills: Fill[] = [];

  #cash: number;
  #qty = 0;
  readonly #costs: CostModel;
  readonly #feed: PaperBrokerOptions['feed'];

  constructor(options: PaperBrokerOptions) {
    this.#cash = options.startingCash;
    this.#costs = options.costs ?? DEFAULT_COSTS;
    this.#feed = options.feed;
  }

  async balance(_symbol?: string): Promise<Balance> {
    return { cash: this.#cash, qty: this.#qty };
  }

  async lastPrice(symbol: string): Promise<number> {
    const candles = await this.#feed(symbol, '1m', 2);
    const last = candles[candles.length - 1];
    if (!last) throw new Error(`no price available for ${symbol}`);
    return last.close;
  }

  async candles(symbol: string, timeframe: Timeframe, bars: number): Promise<Candle[]> {
    return this.#feed(symbol, timeframe, bars);
  }

  async marketBuy(symbol: string, quoteAmount: number): Promise<Fill> {
    const price = buyFillPrice(await this.lastPrice(symbol), this.#costs);
    const spend = Math.min(quoteAmount, this.#cash);
    const fee = feeOn(spend, this.#costs);
    const qty = (spend - fee) / price;
    if (qty <= 0) throw new Error(`insufficient cash to buy ${symbol}: have ${this.#cash}`);
    this.#cash -= spend;
    this.#qty += qty;
    return this.#record({ side: 'buy', qty, price, fee, time: Date.now() });
  }

  async marketSell(symbol: string, qty: number): Promise<Fill> {
    const sellQty = Math.min(qty, this.#qty);
    if (sellQty <= 0) throw new Error(`no ${symbol} position to sell`);
    const price = sellFillPrice(await this.lastPrice(symbol), this.#costs);
    const notional = sellQty * price;
    const fee = feeOn(notional, this.#costs);
    this.#qty -= sellQty;
    this.#cash += notional - fee;
    return this.#record({ side: 'sell', qty: sellQty, price, fee, time: Date.now() });
  }

  #record(fill: Fill): Fill {
    this.fills.push(fill);
    return fill;
  }
}
