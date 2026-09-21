import type { Candle, Position, Timeframe } from '../domain/types.ts';
import { TIMEFRAME_MS } from '../domain/types.ts';
import { RiskManager, type RiskLimits } from '../risk/risk-manager.ts';
import type { StrategyFactory, Params } from '../strategy/types.ts';
import type { Broker } from './broker.ts';
import { StateStore, type RunnerState } from './state-store.ts';

export interface RunnerOptions {
  readonly broker: Broker;
  readonly factory: StrategyFactory;
  readonly params: Params;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly limits: RiskLimits;
  readonly statePath: string;
  readonly log: (message: string) => void;
}

export type Action =
  | 'bought'
  | 'sold'
  | 'stopped-out'
  | 'flattened-by-risk'
  | 'hold'
  | 'already-processed'
  | 'halted'
  | 'warming-up';

export interface StepOutcome {
  readonly action: Action;
  readonly barTime: number;
  readonly price: number;
  readonly equity: number;
  readonly detail: string;
}

/**
 * Drives a strategy against a broker, one closed bar at a time.
 *
 * Three properties matter more than anything else in here:
 *
 * 1. It only ever acts on CLOSED bars. The bar currently forming is discarded,
 *    because a signal computed from a partial bar is a signal that repaints —
 *    it looks profitable in a backtest and does something else entirely live.
 * 2. It records the last bar it acted on and refuses to act on it twice, so a
 *    crash-restart loop cannot place the same order repeatedly.
 * 3. Risk limits are evaluated before the strategy, never after, so a halt
 *    always wins over a signal.
 */
export class LiveRunner {
  readonly #options: RunnerOptions;
  readonly #store: StateStore;
  readonly #risk: RiskManager;
  #state: RunnerState | null = null;

  constructor(options: RunnerOptions, startingEquity: number) {
    this.#options = options;
    this.#store = new StateStore(options.statePath);
    this.#risk = new RiskManager(startingEquity, options.limits);
  }

  async step(): Promise<StepOutcome> {
    const { broker, symbol, timeframe, factory, params, log } = this.#options;
    const state = this.#state ?? (this.#state = await this.#store.load());

    const warmup = factory.create([], params).warmup;
    const raw = await broker.candles(symbol, timeframe, warmup + 50);
    const candles = dropFormingBar(raw, timeframe);
    const bar = candles[candles.length - 1];
    if (!bar) {
      return outcome('warming-up', 0, 0, 0, 'no closed bars available yet');
    }
    if (candles.length <= warmup) {
      return outcome('warming-up', bar.time, bar.close, 0,
        `need ${warmup + 1} closed bars, have ${candles.length}`);
    }

    const balance = await broker.balance(symbol);
    const equity = balance.cash + balance.qty * bar.close;

    if (state.killed) {
      return outcome('halted', bar.time, bar.close, equity,
        `kill switch active: ${state.killReason ?? 'unknown'}. Clear ${this.#options.statePath} to resume.`);
    }
    if (bar.time <= state.lastBarTime) {
      return outcome('already-processed', bar.time, bar.close, equity,
        'this bar was already acted on');
    }

    const risk = this.#risk.onBar(bar.time, equity);
    if (risk.flatten) {
      if (balance.qty > 0) {
        const fill = await broker.marketSell(symbol, balance.qty);
        log(`RISK HALT ${risk.reason} — sold ${fill.qty} at ${fill.price}`);
      }
      state.killed = this.#risk.killed;
      state.killReason = risk.reason;
      state.lastBarTime = bar.time;
      this.#clearPosition(state);
      await this.#store.save(state);
      return outcome('flattened-by-risk', bar.time, bar.close, equity, risk.reason);
    }

    const position = toPosition(state, balance.qty);
    const strategy = factory.create(candles, params);
    const signal = strategy.signalAt(candles.length - 1, position);

    // Poll-based stop. Between polls the position is unprotected, so for any
    // timeframe above a few minutes also leave a resting stop order on the
    // exchange; this check is the backstop, not the primary protection.
    if (position && state.stopPrice !== null && bar.close <= state.stopPrice) {
      const fill = await broker.marketSell(symbol, balance.qty);
      log(`STOP hit at ${bar.close} (stop ${state.stopPrice}) — sold ${fill.qty} at ${fill.price}`);
      this.#clearPosition(state);
      state.lastBarTime = bar.time;
      await this.#store.save(state);
      return outcome('stopped-out', bar.time, bar.close, equity, `stop ${state.stopPrice}`);
    }

    let action: Action = 'hold';
    let detail = signal.reason ?? 'no change';

    if (signal.target > 0 && balance.qty <= 0) {
      const price = await broker.lastPrice(symbol);
      const qty = this.#risk.sizePosition(balance.cash, price, signal.stopPrice);
      const notional = Math.min(qty * price, balance.cash);
      if (notional > 0) {
        const fill = await broker.marketBuy(symbol, notional);
        log(`BUY ${fill.qty.toFixed(8)} ${symbol} at ${fill.price} — ${detail}`);
        state.entryPrice = fill.price;
        state.entryTime = fill.time;
        state.stopPrice = signal.stopPrice ?? null;
        state.highWaterPrice = fill.price;
        action = 'bought';
      } else {
        detail = 'position size rounded to zero; cash too small for the risk limit';
      }
    } else if (signal.target <= 0 && balance.qty > 0) {
      const fill = await broker.marketSell(symbol, balance.qty);
      log(`SELL ${fill.qty.toFixed(8)} ${symbol} at ${fill.price} — ${detail}`);
      this.#clearPosition(state);
      action = 'sold';
    } else if (balance.qty > 0 && signal.stopPrice !== undefined) {
      const next = Math.max(state.stopPrice ?? signal.stopPrice, signal.stopPrice);
      if (next !== state.stopPrice) detail = `stop raised to ${next.toFixed(2)}`;
      state.stopPrice = next;
      state.highWaterPrice = Math.max(state.highWaterPrice ?? bar.close, bar.close);
    }

    state.lastBarTime = bar.time;
    state.peakEquity = Math.max(state.peakEquity, equity);
    await this.#store.save(state);
    return outcome(action, bar.time, bar.close, equity, detail);
  }

  /** Polls at a fraction of the bar interval so a closed bar is picked up promptly. */
  async run(signal?: AbortSignal): Promise<void> {
    const pollMs = Math.max(TIMEFRAME_MS[this.#options.timeframe] / 10, 15_000);
    this.#options.log(
      `runner started: ${this.#options.symbol} ${this.#options.timeframe} on ${this.#options.broker.id}` +
      (this.#options.broker.isLive ? '  *** LIVE FUNDS ***' : '  (paper — no real money)'),
    );
    while (!signal?.aborted) {
      try {
        const result = await this.step();
        if (result.action !== 'already-processed' && result.action !== 'hold') {
          this.#options.log(`[${new Date(result.barTime).toISOString()}] ${result.action}: ${result.detail}`);
        }
      } catch (error) {
        // A transient exchange error must not kill the process and leave a
        // position unmanaged; log it and retry on the next poll.
        this.#options.log(`step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(pollMs, signal);
    }
  }

  #clearPosition(state: RunnerState): void {
    state.entryPrice = null;
    state.entryTime = null;
    state.stopPrice = null;
    state.highWaterPrice = null;
  }
}

function toPosition(state: RunnerState, qty: number): Position | null {
  if (qty <= 0 || state.entryPrice === null) return null;
  return {
    qty,
    entryPrice: state.entryPrice,
    entryTime: state.entryTime ?? 0,
    stopPrice: state.stopPrice ?? undefined,
    highWaterPrice: state.highWaterPrice ?? state.entryPrice,
  };
}

/** Drops the bar still being built, which no strategy may see. */
export function dropFormingBar(candles: readonly Candle[], timeframe: Timeframe, now = Date.now()): Candle[] {
  const barMs = TIMEFRAME_MS[timeframe];
  return candles.filter((c) => c.time + barMs <= now);
}

function outcome(action: Action, barTime: number, price: number, equity: number, detail: string): StepOutcome {
  return { action, barTime, price, equity, detail };
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
