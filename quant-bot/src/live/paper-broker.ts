import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Candle, Timeframe } from '../domain/types.ts';
import { buyFillPrice, DEFAULT_COSTS, feeOn, sellFillPrice, type CostModel } from '../backtest/costs.ts';
import type { Balance, Broker, Fill } from './broker.ts';

export interface PaperBrokerOptions {
  readonly startingCash: number;
  readonly costs: CostModel;
  /** Supplies real market data; only the fills are simulated. */
  readonly feed: (symbol: string, timeframe: Timeframe, bars: number) => Promise<Candle[]>;
  /**
   * Where the simulated account lives between runs. Without it the account
   * is in memory only, and a restart silently resets it to `startingCash` —
   * losing the P&L history and orphaning any open position.
   */
  readonly accountPath?: string;
}

/** The persisted simulated account; also what `status` reads to report P&L. */
export interface PaperAccount {
  readonly startingCash: number;
  readonly cash: number;
  readonly qty: number;
  readonly fills: readonly Fill[];
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

  #startingCash: number;
  #cash: number;
  #qty = 0;
  readonly #costs: CostModel;
  readonly #feed: PaperBrokerOptions['feed'];
  readonly #accountPath: string | undefined;
  #loaded: Promise<void> | null = null;

  constructor(options: PaperBrokerOptions) {
    this.#startingCash = options.startingCash;
    this.#cash = options.startingCash;
    this.#costs = options.costs ?? DEFAULT_COSTS;
    this.#feed = options.feed;
    this.#accountPath = options.accountPath;
  }

  async balance(_symbol?: string): Promise<Balance> {
    await this.#load();
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
    await this.#load();
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
    await this.#load();
    const sellQty = Math.min(qty, this.#qty);
    if (sellQty <= 0) throw new Error(`no ${symbol} position to sell`);
    const price = sellFillPrice(await this.lastPrice(symbol), this.#costs);
    const notional = sellQty * price;
    const fee = feeOn(notional, this.#costs);
    this.#qty -= sellQty;
    this.#cash += notional - fee;
    return this.#record({ side: 'sell', qty: sellQty, price, fee, time: Date.now() });
  }

  async #record(fill: Fill): Promise<Fill> {
    this.fills.push(fill);
    await this.#save();
    return fill;
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      if (!this.#accountPath) return;
      const account = await readPaperAccount(this.#accountPath);
      if (!account) {
        // Write the opening balance now, so `status` works before the first trade.
        await this.#save();
        return;
      }
      // The saved account wins over --equity: resuming a run must not quietly
      // re-fund it, or restarts would turn every loss back into fresh cash.
      this.#startingCash = account.startingCash;
      this.#cash = account.cash;
      this.#qty = account.qty;
      this.fills.push(...account.fills);
    })();
    return this.#loaded;
  }

  async #save(): Promise<void> {
    if (!this.#accountPath) return;
    const account: PaperAccount = {
      startingCash: this.#startingCash,
      cash: this.#cash,
      qty: this.#qty,
      fills: this.fills,
    };
    await mkdir(dirname(this.#accountPath), { recursive: true });
    // Write-then-rename, so a crash mid-write leaves the previous account
    // intact rather than a truncated file that loads as a fresh one.
    const tmp = `${this.#accountPath}.tmp`;
    await writeFile(tmp, JSON.stringify(account, null, 2), 'utf8');
    await rename(tmp, this.#accountPath);
  }
}

export async function readPaperAccount(path: string): Promise<PaperAccount | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PaperAccount>;
    if (typeof parsed.cash !== 'number' || typeof parsed.qty !== 'number') return null;
    return {
      startingCash: parsed.startingCash ?? parsed.cash,
      cash: parsed.cash,
      qty: parsed.qty,
      fills: parsed.fills ?? [],
    };
  } catch {
    return null;
  }
}
