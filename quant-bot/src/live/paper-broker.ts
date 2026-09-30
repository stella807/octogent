import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Candle, Timeframe } from '../domain/types.ts';
import { buyFillPrice, DEFAULT_COSTS, feeOn, sellFillPrice, type CostModel } from '../backtest/costs.ts';
import { OrderRejectedError, type Balance, type Broker, type Fill } from './broker.ts';

/** How far back to look for a coin's latest trade. */
export const PRICE_LOOKBACK_MINUTES = 60;

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
  /** Base-currency quantity held, per symbol. */
  readonly holdings: Readonly<Record<string, number>>;
  readonly fills: readonly Fill[];
  /** Cash moved out to fund other bots. Still this account's profit, just no longer in it. */
  readonly withdrawn: number;
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
  #withdrawn = 0;
  /** Saves run one after another: two overlapping write-then-renames of one file can lose the later state. */
  #saving: Promise<void> = Promise.resolve();
  readonly #holdings = new Map<string, number>();
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

  async balance(symbol: string): Promise<Balance> {
    await this.#load();
    return { cash: this.#cash, qty: this.#holdings.get(symbol) ?? 0 };
  }

  async lastPrice(symbol: string): Promise<number> {
    // Exchanges only publish a 1-minute candle for minutes that traded. A thin
    // market can go several minutes without a trade, and asking for just the
    // last two minutes then finds nothing — failing every order, stop-loss
    // sells included, until someone happens to trade.
    const candles = await this.#feed(symbol, '1m', PRICE_LOOKBACK_MINUTES);
    const last = candles[candles.length - 1];
    if (!last) throw new Error(`no trade in ${symbol} in the last ${PRICE_LOOKBACK_MINUTES} minutes`);
    return last.close;
  }

  async candles(symbol: string, timeframe: Timeframe, bars: number): Promise<Candle[]> {
    return this.#feed(symbol, timeframe, bars);
  }

  async marketBuy(symbol: string, quoteAmount: number): Promise<Fill> {
    await this.#load();
    const spend = Math.min(quoteAmount, this.#cash);
    // The same minimum the backtester enforces. A paper broker that fills
    // orders the exchange would refuse makes small-account paper results
    // look better than anything that could happen live.
    if (spend < this.#costs.minOrderNotional) {
      throw new OrderRejectedError(
        `$${spend.toFixed(2)} is below the $${this.#costs.minOrderNotional} minimum order`,
      );
    }
    const price = buyFillPrice(await this.lastPrice(symbol), this.#costs);
    const fee = feeOn(spend, this.#costs);
    const qty = (spend - fee) / price;
    this.#cash -= spend;
    this.#holdings.set(symbol, (this.#holdings.get(symbol) ?? 0) + qty);
    return this.#record({ symbol, side: 'buy', qty, price, fee, time: Date.now() });
  }

  async marketSell(symbol: string, qty: number): Promise<Fill> {
    await this.#load();
    const held = this.#holdings.get(symbol) ?? 0;
    const sellQty = Math.min(qty, held);
    if (sellQty <= 0) throw new OrderRejectedError(`no ${symbol} position to sell`);
    const price = sellFillPrice(await this.lastPrice(symbol), this.#costs);
    const notional = sellQty * price;
    if (notional < this.#costs.minOrderNotional) {
      throw new OrderRejectedError(
        `$${notional.toFixed(2)} of ${symbol} is below the $${this.#costs.minOrderNotional} minimum order`,
      );
    }
    const fee = feeOn(notional, this.#costs);
    const remaining = held - sellQty;
    if (remaining > 1e-12) this.#holdings.set(symbol, remaining);
    else this.#holdings.delete(symbol);
    this.#cash += notional - fee;
    return this.#record({ symbol, side: 'sell', qty: sellQty, price, fee, time: Date.now() });
  }

  /** Takes up to `amount` of cash out of the account; returns what was actually taken. */
  async withdraw(amount: number): Promise<number> {
    await this.#load();
    const taken = Math.max(0, Math.min(amount, this.#cash));
    this.#cash -= taken;
    this.#withdrawn += taken;
    await this.#save();
    return taken;
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
      this.#withdrawn = account.withdrawn;
      for (const [symbol, qty] of Object.entries(account.holdings)) this.#holdings.set(symbol, qty);
      this.fills.push(...account.fills);
    })();
    return this.#loaded;
  }

  #save(): Promise<void> {
    const path = this.#accountPath;
    if (!path) return Promise.resolve();
    // The snapshot is taken when the save runs, so the last save queued always writes the latest state.
    this.#saving = this.#saving.catch(() => undefined).then(async () => {
      const account: PaperAccount = {
        startingCash: this.#startingCash,
        cash: this.#cash,
        holdings: Object.fromEntries(this.#holdings),
        fills: this.fills,
        withdrawn: this.#withdrawn,
      };
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename, so a crash mid-write leaves the previous account
      // intact rather than a truncated file that loads as a fresh one.
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(account, null, 2), 'utf8');
      await rename(tmp, path);
    });
    return this.#saving;
  }
}

export async function readPaperAccount(path: string): Promise<PaperAccount | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PaperAccount>;
    if (typeof parsed.cash !== 'number') return null;
    return {
      startingCash: parsed.startingCash ?? parsed.cash,
      cash: parsed.cash,
      holdings: parsed.holdings ?? {},
      fills: parsed.fills ?? [],
      withdrawn: parsed.withdrawn ?? 0,
    };
  } catch {
    return null;
  }
}
