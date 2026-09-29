import type { Candle, Position, Timeframe } from '../domain/types.ts';
import { TIMEFRAME_MS } from '../domain/types.ts';
import { RiskManager, type RiskLimits } from '../risk/risk-manager.ts';
import type { StrategyFactory, Params } from '../strategy/types.ts';
import { OrderRejectedError, type Broker, type Fill } from './broker.ts';
import { NoopNotifier, type Notifier } from './notifier.ts';
import { EMPTY_SYMBOL_STATE, StateStore, type RunnerState, type SymbolState } from './state-store.ts';

export interface RunnerOptions {
  readonly broker: Broker;
  readonly factory: StrategyFactory;
  readonly params: Params;
  /** Every symbol shares one account: one cash balance, one equity, one kill switch. */
  readonly symbols: readonly string[];
  readonly timeframe: Timeframe;
  readonly limits: RiskLimits;
  readonly statePath: string;
  readonly log: (message: string) => void;
  /** Pushed a message on the same events that get logged; defaults to doing nothing. */
  readonly notifier?: Notifier;
}

export type Action =
  | 'bought'
  | 'sold'
  | 'stopped-out'
  | 'flattened-by-risk'
  | 'hold'
  | 'already-processed'
  | 'halted'
  | 'warming-up'
  | 'rejected'
  | 'unavailable';

export interface StepOutcome {
  readonly symbol: string;
  readonly action: Action;
  readonly barTime: number;
  readonly price: number;
  readonly equity: number;
  readonly detail: string;
}

/**
 * Drives a strategy against a broker, one closed bar at a time, across any
 * number of symbols that share a single account.
 *
 * Three properties matter more than anything else in here:
 *
 * 1. It only ever acts on CLOSED bars. The bar currently forming is discarded,
 *    because a signal computed from a partial bar is a signal that repaints —
 *    it looks profitable in a backtest and does something else entirely live.
 * 2. It records the last bar it acted on and refuses to act on it twice, so a
 *    crash-restart loop cannot place the same order repeatedly.
 * 3. Risk limits are evaluated before the strategy, never after, so a halt
 *    always wins over a signal. They are evaluated on the whole account's
 *    equity, so a loss in one market counts against the limit for all of them.
 */
export class LiveRunner {
  readonly #options: RunnerOptions;
  readonly #store: StateStore;
  readonly #risk: RiskManager;
  readonly #notifier: Notifier;
  #state: RunnerState | null = null;

  constructor(options: RunnerOptions, startingEquity: number) {
    if (options.symbols.length === 0) throw new RangeError('the runner needs at least one symbol');
    if (new Set(options.symbols).size !== options.symbols.length) {
      throw new RangeError(`duplicate symbols: ${options.symbols.join(', ')}`);
    }
    this.#options = options;
    this.#store = new StateStore(options.statePath);
    this.#risk = new RiskManager(startingEquity, options.limits);
    this.#notifier = options.notifier ?? NoopNotifier;
  }

  /** Never lets a broken notifier affect a trade — only the message about it can fail. */
  async #notify(message: string): Promise<void> {
    try {
      await this.#notifier.notify(message);
    } catch (error) {
      this.#options.log(`notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** One outcome per symbol, in the order the symbols were configured. */
  async step(): Promise<StepOutcome[]> {
    const { broker, symbols, factory, params, statePath } = this.#options;
    const state = this.#state ?? (this.#state = await this.#store.load());
    const warmup = factory.create([], params).warmup;

    // Sequential rather than parallel: every symbol hits the same exchange,
    // and a burst of concurrent requests is how a bot gets rate limited.
    const markets: Market[] = [];
    for (const symbol of symbols) markets.push(await this.#market(symbol, warmup));

    let cash = 0;
    const holdings = new Map<string, number>();
    for (const m of markets) {
      const balance = await broker.balance(m.symbol);
      cash = balance.cash;
      holdings.set(m.symbol, balance.qty);
    }
    // A symbol whose data failed this poll is marked at its entry price rather
    // than dropped, so a data outage cannot masquerade as a drawdown.
    const equity = cash + markets.reduce((sum, m) => {
      const mark = m.bar?.close ?? state.symbols[m.symbol]?.entryPrice ?? 0;
      return sum + (holdings.get(m.symbol) ?? 0) * mark;
    }, 0);

    if (state.killed) {
      return markets.map((m) => outcome(m.symbol, 'halted', m.bar?.time ?? 0, m.bar?.close ?? 0, equity,
        `kill switch active: ${state.killReason ?? 'unknown'}. Clear ${statePath} to resume.`));
    }

    const newest = Math.max(0, ...markets.map((m) => m.bar?.time ?? 0));
    if (newest > state.lastRiskBarTime) {
      const risk = this.#risk.onBar(newest, equity);
      if (risk.flatten) return this.#flattenAll(markets, holdings, equity, newest, risk.reason);
      state.lastRiskBarTime = newest;
    }

    const outcomes: StepOutcome[] = [];
    for (const m of markets) {
      if (m.error !== undefined) {
        outcomes.push(outcome(m.symbol, 'unavailable', 0, 0, equity, m.error));
        continue;
      }
      const bar = m.bar;
      if (!bar) {
        outcomes.push(outcome(m.symbol, 'warming-up', 0, 0, equity, 'no closed bars available yet'));
        continue;
      }
      if (m.candles.length <= warmup) {
        outcomes.push(outcome(m.symbol, 'warming-up', bar.time, bar.close, equity,
          `need ${warmup + 1} closed bars, have ${m.candles.length}`));
        continue;
      }
      const s = (state.symbols[m.symbol] ??= { ...EMPTY_SYMBOL_STATE });
      if (bar.time <= s.lastBarTime) {
        outcomes.push(outcome(m.symbol, 'already-processed', bar.time, bar.close, equity,
          'this bar was already acted on'));
        continue;
      }
      outcomes.push(await this.#decide(m.symbol, m.candles, bar, s, holdings.get(m.symbol) ?? 0, equity));
      // Saved after every symbol, not once at the end: if a later symbol's
      // request throws, an order already placed here must not be forgotten.
      await this.#store.save(state);
    }

    state.peakEquity = Math.max(state.peakEquity, equity);
    await this.#store.save(state);
    return outcomes;
  }

  async #market(symbol: string, warmup: number): Promise<Market> {
    try {
      const raw = await this.#options.broker.candles(symbol, this.#options.timeframe, warmup + 50);
      const candles = dropFormingBar(raw, this.#options.timeframe);
      return { symbol, candles, bar: candles[candles.length - 1] };
    } catch (error) {
      // One delisted or failing market must not stop the others trading.
      return { symbol, candles: [], bar: undefined, error: `market data unavailable: ${describe(error)}` };
    }
  }

  async #flattenAll(
    markets: readonly Market[],
    holdings: ReadonlyMap<string, number>,
    equity: number,
    riskBarTime: number,
    reason: string,
  ): Promise<StepOutcome[]> {
    const state = this.#state as RunnerState;
    const outcomes: StepOutcome[] = [];
    for (const m of markets) {
      const qty = holdings.get(m.symbol) ?? 0;
      const s = (state.symbols[m.symbol] ??= { ...EMPTY_SYMBOL_STATE });
      if (qty > 0) {
        const sold = await this.#trade('sell', m.symbol, qty,
          (fill) => `RISK HALT ${reason} — sold ${fill.qty} ${m.symbol} at ${fill.price}`);
        if (sold.rejected !== undefined) {
          outcomes.push(outcome(m.symbol, 'rejected', m.bar?.time ?? 0, m.bar?.close ?? 0, equity,
            `risk-halt sell refused: ${sold.rejected}`));
          continue;
        }
      }
      clearPosition(s);
      s.lastBarTime = Math.max(s.lastBarTime, m.bar?.time ?? 0);
      outcomes.push(outcome(m.symbol, 'flattened-by-risk', m.bar?.time ?? 0, m.bar?.close ?? 0, equity, reason));
    }
    // Only marked done once every sell has gone through; a sell that threw
    // leaves it unmarked so the next poll runs the halt again.
    state.lastRiskBarTime = riskBarTime;
    state.killed = this.#risk.killed;
    state.killReason = reason;
    await this.#store.save(state);
    return outcomes;
  }

  async #decide(
    symbol: string,
    candles: readonly Candle[],
    bar: Candle,
    s: SymbolState,
    qty: number,
    equity: number,
  ): Promise<StepOutcome> {
    const { broker, factory, params } = this.#options;
    const position = toPosition(s, qty, (this.#state as RunnerState).peakEquity);
    const signal = factory.create(candles, params).signalAt(candles.length - 1, position);
    s.lastBarTime = bar.time;

    // Poll-based stop. Between polls the position is unprotected, so for any
    // timeframe above a few minutes also leave a resting stop order on the
    // exchange; this check is the backstop, not the primary protection.
    if (position && s.stopPrice !== null && bar.close <= s.stopPrice) {
      const stop = s.stopPrice;
      const sold = await this.#trade('sell', symbol, qty,
        (fill) => `STOP hit at ${bar.close} (stop ${stop}) — sold ${fill.qty} ${symbol} at ${fill.price}`);
      if (sold.rejected !== undefined) {
        return outcome(symbol, 'rejected', bar.time, bar.close, equity, `stop sell refused: ${sold.rejected}`);
      }
      clearPosition(s);
      return outcome(symbol, 'stopped-out', bar.time, bar.close, equity, `stop ${stop}`);
    }

    const reason = signal.reason ?? 'no change';

    if (signal.target > 0 && qty <= 0) {
      // Sized off the whole account's equity, capped by the cash actually
      // free. Sizing off one symbol's slice would put most orders under the
      // exchange minimum on a small account.
      const { cash } = await broker.balance(symbol);
      const price = await broker.lastPrice(symbol);
      const notional = Math.min(this.#risk.sizePosition(equity, price, signal.stopPrice) * price, cash);
      if (notional <= 0) {
        return outcome(symbol, 'hold', bar.time, bar.close, equity,
          'position size rounded to zero; cash too small for the risk limit');
      }
      const bought = await this.#trade('buy', symbol, notional,
        (fill) => `BUY ${fill.qty.toFixed(8)} ${symbol} at ${fill.price} — ${reason}`);
      if (bought.rejected !== undefined) {
        return outcome(symbol, 'rejected', bar.time, bar.close, equity, `buy refused: ${bought.rejected}`);
      }
      s.entryPrice = bought.fill.price;
      s.entryTime = bought.fill.time;
      s.stopPrice = signal.stopPrice ?? null;
      s.highWaterPrice = bought.fill.price;
      return outcome(symbol, 'bought', bar.time, bar.close, equity, reason);
    }

    if (signal.target <= 0 && qty > 0) {
      const sold = await this.#trade('sell', symbol, qty,
        (fill) => `SELL ${fill.qty.toFixed(8)} ${symbol} at ${fill.price} — ${reason}`);
      if (sold.rejected !== undefined) {
        return outcome(symbol, 'rejected', bar.time, bar.close, equity, `sell refused: ${sold.rejected}`);
      }
      clearPosition(s);
      return outcome(symbol, 'sold', bar.time, bar.close, equity, reason);
    }

    if (qty > 0 && signal.stopPrice !== undefined) {
      const next = Math.max(s.stopPrice ?? signal.stopPrice, signal.stopPrice);
      const raised = next !== s.stopPrice;
      s.stopPrice = next;
      s.highWaterPrice = Math.max(s.highWaterPrice ?? bar.close, bar.close);
      if (raised) return outcome(symbol, 'hold', bar.time, bar.close, equity, `stop raised to ${next.toFixed(2)}`);
    }
    return outcome(symbol, 'hold', bar.time, bar.close, equity, reason);
  }

  /**
   * Places one order and reports it. A refusal comes back as a value rather
   * than an exception: it is a normal outcome of trading a small account, and
   * the runner has to keep managing every other symbol when it happens.
   */
  async #trade(
    side: 'buy' | 'sell',
    symbol: string,
    amount: number,
    describeFill: (fill: Fill) => string,
  ): Promise<{ fill: Fill; rejected?: undefined } | { fill?: undefined; rejected: string }> {
    const { broker, log } = this.#options;
    try {
      const fill = side === 'buy'
        ? await broker.marketBuy(symbol, amount)
        : await broker.marketSell(symbol, amount);
      const message = describeFill(fill);
      log(message);
      await this.#notify(message);
      return { fill };
    } catch (error) {
      if (!(error instanceof OrderRejectedError)) throw error;
      log(`${side.toUpperCase()} ${symbol} refused: ${error.message}`);
      return { rejected: error.message };
    }
  }

  /** Polls at a fraction of the bar interval so a closed bar is picked up promptly. */
  async run(signal?: AbortSignal): Promise<void> {
    const pollMs = Math.max(TIMEFRAME_MS[this.#options.timeframe] / 10, 15_000);
    this.#options.log(
      `runner started: ${this.#options.symbols.join(', ')} ${this.#options.timeframe} on ${this.#options.broker.id}` +
      (this.#options.broker.isLive ? '  *** LIVE FUNDS ***' : '  (paper — no real money)'),
    );
    // A halted or warming-up symbol reports the same status on every poll;
    // repeating it every few minutes buries the lines that actually matter.
    const lastStatus = new Map<string, string>();
    while (!signal?.aborted) {
      try {
        for (const result of await this.step()) {
          const status = `${result.action}: ${result.detail}`;
          if (result.action === 'already-processed' || result.action === 'hold') continue;
          if (lastStatus.get(result.symbol) === status) continue;
          lastStatus.set(result.symbol, status);
          const when = result.barTime > 0 ? new Date(result.barTime).toISOString() : 'no bar';
          this.#options.log(`[${when}] ${result.symbol} ${status}`);
        }
      } catch (error) {
        // A transient exchange error must not kill the process and leave a
        // position unmanaged; log it and retry on the next poll.
        this.#options.log(`step failed: ${describe(error)}`);
      }
      await sleep(pollMs, signal);
    }
  }
}

interface Market {
  readonly symbol: string;
  readonly candles: Candle[];
  readonly bar: Candle | undefined;
  readonly error?: string;
}

function clearPosition(s: SymbolState): void {
  s.entryPrice = null;
  s.entryTime = null;
  s.stopPrice = null;
  s.highWaterPrice = null;
}

function toPosition(s: SymbolState, qty: number, peakEquity: number): Position | null {
  if (qty <= 0 || s.entryPrice === null) return null;
  return {
    qty,
    entryPrice: s.entryPrice,
    entryTime: s.entryTime ?? 0,
    stopPrice: s.stopPrice ?? undefined,
    highWaterPrice: s.highWaterPrice ?? s.entryPrice,
    // The live runner holds one tranche at a time, so there is nothing
    // realized or averaged yet; these exist for the backtester's partial fills.
    realizedPnl: 0,
    feesPaid: 0,
    peakQty: qty,
    equityAtEntry: peakEquity,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Drops the bar still being built, which no strategy may see. */
export function dropFormingBar(candles: readonly Candle[], timeframe: Timeframe, now = Date.now()): Candle[] {
  const barMs = TIMEFRAME_MS[timeframe];
  return candles.filter((c) => c.time + barMs <= now);
}

function outcome(
  symbol: string,
  action: Action,
  barTime: number,
  price: number,
  equity: number,
  detail: string,
): StepOutcome {
  return { symbol, action, barTime, price, equity, detail };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
