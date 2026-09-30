import type { Candle, Timeframe } from '../domain/types.ts';
import { OrderRejectedError, type Balance, type Broker, type Fill } from './broker.ts';

export const LIVE_CONFIRM_ENV = 'QUANT_BOT_LIVE_CONFIRM';
export const LIVE_CONFIRM_VALUE = 'yes-i-accept-the-risk';

export interface ExchangeBrokerOptions {
  readonly exchange: string;
  /** Read from the environment by `fromEnv`; never hardcode or log these. */
  readonly apiKey: string;
  readonly secret: string;
  /** Injectable for tests; production connects through ccxt on first use. */
  readonly client?: CcxtClient;
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
    this.#client = options.client ?? null;
    this.id = `live:${options.exchange}`;
  }

  /**
   * Builds from environment variables so credentials never enter argv, where
   * they would be visible in shell history and in `ps` output.
   */
  static fromEnv(exchange: string): ExchangeBroker {
    return new ExchangeBroker({
      exchange,
      apiKey: process.env['QUANT_BOT_API_KEY'] ?? '',
      secret: process.env['QUANT_BOT_API_SECRET'] ?? '',
    });
  }

  async balance(symbol: string): Promise<Balance> {
    const client = await this.#connect();
    const balances = await client.fetchBalance();
    // Both sides come from the symbol being traded. A fixed quote currency
    // reads the wrong balance on any venue that does not use it: on Coinbase
    // BTC/USD, a USDT default reports $0 cash and every order sizes to zero.
    const [base = '', quote = ''] = symbol.split('/');
    return {
      cash: Number(balances.free?.[quote] ?? 0),
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
    const order = await asRejection(client.createMarketBuyOrder(symbol, qty));
    return toFill(symbol, 'buy', order, price, qty);
  }

  async marketSell(symbol: string, qty: number): Promise<Fill> {
    const client = await this.#connect();
    const price = await this.lastPrice(symbol);
    const order = await asRejection(client.createMarketSellOrder(symbol, qty));
    return toFill(symbol, 'sell', order, price, qty);
  }

  /** Every balance and its value in `quote`, for the start-of-run baseline and `status --live`. */
  async account(quote: string): Promise<AccountSnapshot> {
    return readAccount(await this.#connect(), quote);
  }

  async #connect(): Promise<CcxtClient> {
    this.#client ??= await connectCcxt(this.#options.exchange, this.#options.apiKey, this.#options.secret);
    return this.#client;
  }
}

async function connectCcxt(exchange: string, apiKey: string, secret: string): Promise<CcxtClient> {
  const ccxt = (await import('ccxt')) as unknown as Record<string, unknown>;
  const ExchangeClass = ccxt[exchange];
  if (typeof ExchangeClass !== 'function') {
    throw new Error(`ccxt has no exchange named "${exchange}"`);
  }
  return new (ExchangeClass as new (cfg: unknown) => CcxtClient)({ apiKey, secret, enableRateLimit: true });
}

/** The two calls that only read an account. Nothing reachable through it can place an order. */
export type AccountReader = Pick<CcxtClient, 'fetchBalance' | 'fetchTicker'>;

/**
 * Reading balances needs no live-trading confirmation: it cannot move money.
 * A key with only "view" permission is enough, and is the safer key to use.
 */
export async function connectReadOnly(exchange: string): Promise<AccountReader> {
  const apiKey = process.env['QUANT_BOT_API_KEY'] ?? '';
  const secret = process.env['QUANT_BOT_API_SECRET'] ?? '';
  if (!apiKey || !secret) {
    throw new Error('reading a real account needs QUANT_BOT_API_KEY and QUANT_BOT_API_SECRET; see .env.example');
  }
  const client = await connectCcxt(exchange, apiKey, secret);
  return { fetchBalance: () => client.fetchBalance(), fetchTicker: (symbol) => client.fetchTicker(symbol) };
}

export interface AccountSnapshot {
  /** Total (free + held in open orders) per asset, zero balances dropped. */
  readonly balances: Readonly<Record<string, number>>;
  /** Price of one unit in the quote currency; null when no market could price it. */
  readonly prices: Readonly<Record<string, number | null>>;
}

/**
 * Coinbase converts USDC to USD one-for-one and may list no USDC/USD market, so
 * pricing it through a ticker would report real money as unpriced.
 */
const PAR_WITH_USD = new Set(['USDC']);

export async function readAccount(client: AccountReader, quote: string): Promise<AccountSnapshot> {
  let raw: Awaited<ReturnType<AccountReader['fetchBalance']>>;
  try {
    raw = await client.fetchBalance();
  } catch (error) {
    if (error instanceof Error && error.constructor.name === 'AuthenticationError') {
      throw new Error(
        'the exchange rejected the API key. Check QUANT_BOT_API_KEY and QUANT_BOT_API_SECRET ' +
        `were copied whole, and that the key has at least "view" permission (${error.message})`,
      );
    }
    throw error;
  }
  const balances: Record<string, number> = {};
  for (const [asset, amount] of Object.entries(raw.total ?? raw.free ?? {})) {
    const qty = Number(amount);
    if (Number.isFinite(qty) && qty > 0) balances[asset] = qty;
  }
  const prices: Record<string, number | null> = {};
  // Sequential: one request per coin, and a burst of them is how a key gets rate limited.
  for (const asset of Object.keys(balances)) {
    if (asset === quote || (quote === 'USD' && PAR_WITH_USD.has(asset))) {
      prices[asset] = 1;
      continue;
    }
    try {
      const ticker = await client.fetchTicker(`${asset}/${quote}`);
      const price = ticker.last ?? ticker.close;
      prices[asset] = typeof price === 'number' && Number.isFinite(price) ? price : null;
    } catch {
      prices[asset] = null;
    }
  }
  return { balances, prices };
}

interface CcxtOrder {
  readonly average?: number;
  readonly price?: number;
  readonly filled?: number;
  readonly fee?: { readonly cost?: number };
  readonly timestamp?: number;
}

export interface CcxtClient {
  fetchBalance(): Promise<{ free?: Record<string, number>; total?: Record<string, number> }>;
  fetchTicker(symbol: string): Promise<{ last?: number; close?: number }>;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<(number | undefined)[][]>;
  createMarketBuyOrder(symbol: string, qty: number): Promise<CcxtOrder>;
  createMarketSellOrder(symbol: string, qty: number): Promise<CcxtOrder>;
}

/**
 * ccxt signals a refused order with InvalidOrder (size, precision) or
 * InsufficientFunds. Those are permanent for this order; everything else —
 * timeouts, rate limits, exchange downtime — stays a plain error so the
 * runner retries it on the next poll.
 */
async function asRejection(order: Promise<CcxtOrder>): Promise<CcxtOrder> {
  try {
    return await order;
  } catch (error) {
    const kind = error instanceof Error ? error.constructor.name : '';
    if (kind === 'InvalidOrder' || kind === 'InsufficientFunds' || kind === 'OrderNotFillable') {
      throw new OrderRejectedError((error as Error).message);
    }
    throw error;
  }
}

function toFill(
  symbol: string,
  side: 'buy' | 'sell',
  order: CcxtOrder,
  fallbackPrice: number,
  fallbackQty: number,
): Fill {
  return {
    symbol,
    side,
    qty: order.filled ?? fallbackQty,
    price: order.average ?? order.price ?? fallbackPrice,
    fee: order.fee?.cost ?? 0,
    time: order.timestamp ?? Date.now(),
  };
}
