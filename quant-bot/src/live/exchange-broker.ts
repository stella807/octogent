import type { Candle, Timeframe } from '../domain/types.ts';
import type { Balance, Broker, Fill } from './broker.ts';

export const LIVE_CONFIRM_ENV = 'QUANT_BOT_LIVE_CONFIRM';
export const LIVE_CONFIRM_VALUE = 'yes-i-accept-the-risk';

export interface ExchangeBrokerOptions {
  readonly exchange: string;
  /** Read from the environment by `fromEnv`; never hardcode or log these. */
  readonly apiKey: string;
  readonly secret: string;
  readonly quoteCurrency: string;
}

/**
 * Real orders against a real exchange.
 *
 * Two independent gates stand in front of it: a `--live` flag a human types,
 * and an environment variable a human sets. Either alone is not enough. This
 * is not ceremony — the most common way an automated trading system loses
 * money is a test run against the wrong endpoint, and a single flag is one
 * typo away from that.
 */
export class ExchangeBroker implements Broker {
  readonly id: string;
  readonly isLive = true;
  readonly #quote: string;
  #client: CcxtClient | null = null;
  readonly #options: ExchangeBrokerOptions;

  constructor(options: ExchangeBrokerOptions) {
    if (process.env[LIVE_CONFIRM_ENV] !== LIVE_CONFIRM_VALUE) {
      throw new Error(
        `Refusing to trade live: set ${LIVE_CONFIRM_ENV}=${LIVE_CONFIRM_VALUE} to confirm you understand this risks real funds.`,
      );
    }
    if (!options.apiKey || !options.secret) {
      throw new Error('live trading needs API credentials; see .env.example');
    }
    this.#options = options;
    this.#quote = options.quoteCurrency;
    this.id = `live:${options.exchange}`;
  }

  /**
   * Builds from environment variables so credentials never enter argv, where
   * they would be visible in shell history and in `ps` output.
   */
  static fromEnv(exchange: string, quoteCurrency = 'USDT'): ExchangeBroker {
    return new ExchangeBroker({
      exchange,
      apiKey: process.env['QUANT_BOT_API_KEY'] ?? '',
      secret: process.env['QUANT_BOT_API_SECRET'] ?? '',
      quoteCurrency,
    });
  }

  async balance(symbol: string): Promise<Balance> {
    const client = await this.#connect();
    const balances = await client.fetchBalance();
    const base = symbol.split('/')[0] ?? '';
    return {
      cash: Number(balances.free?.[this.#quote] ?? 0),
      qty: Number(balances.free?.[base] ?? 0),
    };
  }

  async lastPrice(symbol: string): Promise<number> {
    const client = await this.#connect();
    const ticker = await client.fetchTicker(symbol);
    const price = ticker.last ?? ticker.close;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new Error(`exchange returned no usable price for ${symbol}`);
    }
    return price;
  }

  async candles(symbol: string, timeframe: Timeframe, bars: number): Promise<Candle[]> {
    const client = await this.#connect();
    const rows = await client.fetchOHLCV(symbol, timeframe, undefined, bars);
    return rows
      .filter((r): r is number[] => r[0] !== undefined)
      .map((r) => ({
        time: r[0] as number,
        open: r[1] ?? 0,
        high: r[2] ?? 0,
        low: r[3] ?? 0,
        close: r[4] ?? 0,
        volume: r[5] ?? 0,
      }));
  }

  async marketBuy(symbol: string, quoteAmount: number): Promise<Fill> {
    const client = await this.#connect();
    const price = await this.lastPrice(symbol);
    const qty = quoteAmount / price;
    const order = await client.createMarketBuyOrder(symbol, qty);
    return toFill('buy', order, price, qty);
  }

  async marketSell(symbol: string, qty: number): Promise<Fill> {
    const client = await this.#connect();
    const price = await this.lastPrice(symbol);
    const order = await client.createMarketSellOrder(symbol, qty);
    return toFill('sell', order, price, qty);
  }

  async #connect(): Promise<CcxtClient> {
    if (this.#client) return this.#client;
    const ccxt = (await import('ccxt')) as unknown as Record<string, unknown>;
    const ExchangeClass = ccxt[this.#options.exchange];
    if (typeof ExchangeClass !== 'function') {
      throw new Error(`ccxt has no exchange named "${this.#options.exchange}"`);
    }
    this.#client = new (ExchangeClass as new (cfg: unknown) => CcxtClient)({
      apiKey: this.#options.apiKey,
      secret: this.#options.secret,
      enableRateLimit: true,
    });
    return this.#client;
  }
}

interface CcxtOrder {
  readonly average?: number;
  readonly price?: number;
  readonly filled?: number;
  readonly fee?: { readonly cost?: number };
  readonly timestamp?: number;
}

interface CcxtClient {
  fetchBalance(): Promise<{ free?: Record<string, number> }>;
  fetchTicker(symbol: string): Promise<{ last?: number; close?: number }>;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<(number | undefined)[][]>;
  createMarketBuyOrder(symbol: string, qty: number): Promise<CcxtOrder>;
  createMarketSellOrder(symbol: string, qty: number): Promise<CcxtOrder>;
}

function toFill(side: 'buy' | 'sell', order: CcxtOrder, fallbackPrice: number, fallbackQty: number): Fill {
  return {
    side,
    qty: order.filled ?? fallbackQty,
    price: order.average ?? order.price ?? fallbackPrice,
    fee: order.fee?.cost ?? 0,
    time: order.timestamp ?? Date.now(),
  };
}
