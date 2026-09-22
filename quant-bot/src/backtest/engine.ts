import type { Candle, EquityPoint, ExitReason, Position, Timeframe, Trade } from '../domain/types.ts';
import { RiskManager, type HaltKind, type RiskLimits, DEFAULT_LIMITS } from '../risk/risk-manager.ts';
import type { Strategy } from '../strategy/types.ts';
import { buyFillPrice, DEFAULT_COSTS, feeOn, sellFillPrice, type CostModel } from './costs.ts';

export interface BacktestConfig {
  readonly startingEquity: number;
  readonly costs: CostModel;
  readonly limits: RiskLimits;
  readonly timeframe: Timeframe;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  startingEquity: 10_000,
  costs: DEFAULT_COSTS,
  limits: DEFAULT_LIMITS,
  timeframe: '1d',
};

export interface HaltRecord {
  readonly kind: HaltKind;
  readonly reason: string;
  readonly time: number;
}

export interface BacktestResult {
  /** Orders the exchange would have refused for being below its minimum size. */
  readonly rejectedOrders?: number;
  readonly strategy: { readonly name: string; readonly params: Readonly<Record<string, number>> };
  readonly config: BacktestConfig;
  readonly equityCurve: readonly EquityPoint[];
  readonly trades: readonly Trade[];
  readonly startingEquity: number;
  readonly endingEquity: number;
  readonly firstHalt: HaltRecord | null;
  readonly barsTested: number;
}

/**
 * A target exposure to reach at the next bar's open, rather than a buy/sell
 * instruction. Expressing orders as a target is what lets a strategy hold a
 * fraction of full size (volatility targeting, portfolio weights) without the
 * engine having to know which kind of strategy produced it.
 */
interface Pending {
  readonly target: number;
  readonly stopPrice: number | undefined;
  readonly reason: string;
}

/**
 * How far the requested exposure must move before an existing position is
 * resized, in fractions of equity.
 *
 * The comparison is against the target last acted on, not against the position
 * the risk manager would size today. Those differ constantly — a trailing stop
 * moves, equity drifts — so sizing off the latter makes a strategy that asks
 * for the same exposure every bar retrade every bar. On eight years of BTC
 * that quadrupled fees and took ~7 points off the return without changing a
 * single entry or exit decision.
 *
 * A binary strategy holds its target at 1 and therefore never rebalances. Only
 * a strategy that genuinely varies its exposure pays for the privilege.
 */
const REBALANCE_THRESHOLD = 0.1;

/**
 * Bar-by-bar simulation with a strict causality rule:
 *
 *   a signal derived from the close of bar `i` is filled at the OPEN of bar `i+1`.
 *
 * Filling at the close of the bar that produced the signal is the most common
 * backtesting bug in this space, and it is worth roughly the entire apparent
 * edge of most published strategies. Protective stops are the sole exception:
 * they are resting orders, so they are allowed to fill intrabar — and when the
 * bar gaps straight through the stop, the fill is the gapped open, not the
 * stop price. That asymmetry is what makes the numbers this engine prints
 * believable rather than flattering.
 */
export function runBacktest(
  candles: readonly Candle[],
  strategy: Strategy,
  config: BacktestConfig = DEFAULT_CONFIG,
): BacktestResult {
  if (config.startingEquity <= 0) {
    throw new RangeError(`startingEquity must be > 0, got ${config.startingEquity}`);
  }
  assertChronological(candles);

  const { costs } = config;
  const risk = new RiskManager(config.startingEquity, config.limits);
  const equityCurve: EquityPoint[] = [];
  const trades: Trade[] = [];

  let cash = config.startingEquity;
  let position: Position | null = null;
  let pending: Pending | null = null;
  let entryBar = 0;
  let firstHalt: HaltRecord | null = null;
  let rejectedOrders = 0;
  /** The exposure most recently acted on, which rebalancing is measured against. */
  let lastTarget = 0;

  /** Books a partial or full reduction, and emits a Trade when the position closes. */
  const reduce = (
    sellQty: number,
    fillPrice: number,
    time: number,
    barIndex: number,
    reason: ExitReason,
  ): void => {
    if (!position || sellQty <= 0) return;
    const qty = Math.min(sellQty, position.qty);
    const notional = qty * fillPrice;
    // End-of-data liquidation is an accounting close, not an order, so it is
    // exempt. Everything else the exchange would refuse is refused here too,
    // which is how a position too small to sell shows up as the dust it is.
    if (reason !== 'end-of-data' && notional < costs.minOrderNotional) {
      rejectedOrders += 1;
      return;
    }
    const fee = feeOn(notional, costs);
    cash += notional - fee;
    const realized = position.realizedPnl + qty * (fillPrice - position.entryPrice);
    const fees = position.feesPaid + fee;
    const remaining = position.qty - qty;

    if (remaining > 1e-12) {
      position = { ...position, qty: remaining, realizedPnl: realized, feesPaid: fees };
      return;
    }

    const basis = position.peakQty * position.entryPrice;
    const pnl = realized - fees;
    trades.push({
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice: fillPrice,
      qty: position.peakQty,
      pnl,
      pnlPct: basis > 0 ? pnl / basis : 0,
      equityAtEntry: position.equityAtEntry,
      returnOnEquity: position.equityAtEntry > 0 ? pnl / position.equityAtEntry : 0,
      fees,
      exitReason: reason,
      barsHeld: barIndex - entryBar,
    });
    position = null;
  };

  /** Books a new tranche, rolling the weighted-average cost forward. */
  const add = (wantQty: number, fillPrice: number, time: number, barIndex: number): void => {
    if (wantQty <= 0 || !Number.isFinite(wantQty) || fillPrice <= 0) return;
    // Clamp to what cash covers rather than rejecting. The 1-ULP shrink
    // matters: a fully-invested target computes a quantity whose notional plus
    // fee rounds a hair above cash, and a strict `>` would decline to trade.
    const maxQty = (cash / (fillPrice * (1 + costs.feeBps / 10_000))) * (1 - 1e-12);
    const buyQty = Math.min(wantQty, maxQty);
    if (buyQty <= 0) return;
    const notional = buyQty * fillPrice;
    if (notional < costs.minOrderNotional) {
      rejectedOrders += 1;
      return;
    }
    const fee = feeOn(notional, costs);
    const equityNow = cash + (position ? position.qty * fillPrice : 0);
    cash -= notional + fee;

    const current = position;
    if (current === null) {
      entryBar = barIndex;
      position = {
        qty: buyQty,
        entryPrice: fillPrice,
        entryTime: time,
        stopPrice: undefined,
        highWaterPrice: fillPrice,
        realizedPnl: 0,
        feesPaid: fee,
        peakQty: buyQty,
        equityAtEntry: equityNow,
      };
      return;
    }
    const total = current.qty + buyQty;
    position = {
      ...current,
      qty: total,
      entryPrice: (current.qty * current.entryPrice + notional) / total,
      feesPaid: current.feesPaid + fee,
      peakQty: Math.max(current.peakQty, total),
    };
  };

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;

    // 1. Move to the target decided at the last bar's close, at this bar's open.
    if (pending) {
      const held = position?.qty ?? 0;
      if (pending.target <= 0) {
        if (held > 0) reduce(held, sellFillPrice(bar.open, costs), bar.time, i, 'signal');
        lastTarget = 0;
      } else {
        const buyPrice = buyFillPrice(bar.open, costs);
        const equity = cash + held * buyPrice;
        const full = risk.sizePosition(equity, buyPrice, pending.stopPrice);
        const target = Math.min(pending.target, 1);
        const desired = full * target;
        const delta = desired - held;
        if (delta > 0) {
          add(delta, buyPrice, bar.time, i);
        } else if (delta < 0 && held > 0) {
          reduce(-delta, sellFillPrice(bar.open, costs), bar.time, i, 'signal');
        }
        if (position !== null) lastTarget = target;
        // `add`/`reduce` reassign `position`, so re-read it after those calls.
        const opened: Position | null = position;
        if (opened !== null && pending.stopPrice !== undefined) {
          position = withStop(opened, pending.stopPrice);
        }
      }
      pending = null;
    }

    // 2. Resting stop, checked against this bar's low.
    if (position !== null && position.stopPrice !== undefined && bar.low <= position.stopPrice) {
      const touched = bar.open <= position.stopPrice ? bar.open : position.stopPrice;
      reduce(position.qty, sellFillPrice(touched, costs), bar.time, i, 'stop');
    }

    if (position !== null && bar.close > position.highWaterPrice) {
      position = { ...position, highWaterPrice: bar.close };
    }

    // 3. Mark to market.
    const equity = cash + (position ? position.qty * bar.close : 0);
    equityCurve.push({
      time: bar.time,
      equity,
      exposure: equity > 0 && position ? (position.qty * bar.close) / equity : 0,
    });

    // 4. Risk limits run before the strategy, so a halt always wins over a signal.
    const state = risk.onBar(bar.time, equity);
    if (state.flatten) {
      if (position !== null) {
        reduce(position.qty, sellFillPrice(bar.close, costs), bar.time, i, 'risk-halt');
      }
      if (firstHalt === null) {
        firstHalt = { kind: state.halt, reason: state.reason, time: bar.time };
      }
      pending = null;
      continue;
    }

    // 5. Ask the strategy. Skip the final bar: an order there could never fill.
    if (i >= strategy.warmup && i < candles.length - 1) {
      const signal = strategy.signalAt(i, position);
      const wantsExit = signal.target <= 0 && position !== null;
      const wantsEntry = signal.target > 0 && position === null;
      const wantsResize = position !== null
        && Math.abs(signal.target - lastTarget) >= REBALANCE_THRESHOLD;
      if (wantsExit || wantsEntry || wantsResize) {
        pending = {
          target: signal.target,
          stopPrice: signal.stopPrice,
          reason: signal.reason ?? '',
        };
      }
      // Stops ratchet up only, and take effect immediately rather than waiting
      // for the next fill: a stop that can be loosened is not a stop.
      const open: Position | null = position;
      if (open !== null && signal.stopPrice !== undefined) {
        position = withStop(open, signal.stopPrice);
      }
    }
  }

  if (position !== null && candles.length > 0) {
    const last = candles[candles.length - 1] as Candle;
    reduce(position.qty, sellFillPrice(last.close, costs), last.time, candles.length - 1, 'end-of-data');
  }

  return {
    strategy: { name: strategy.name, params: strategy.params },
    config,
    equityCurve,
    trades,
    startingEquity: config.startingEquity,
    endingEquity: cash,
    firstHalt,
    rejectedOrders,
    barsTested: candles.length,
  };
}

/** Raises a stop, never lowers it. */
function withStop(position: Position, stopPrice: number): Position {
  return { ...position, stopPrice: Math.max(position.stopPrice ?? stopPrice, stopPrice) };
}

function assertChronological(candles: readonly Candle[]): void {
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1] as Candle;
    const cur = candles[i] as Candle;
    if (cur.time <= prev.time) {
      throw new RangeError(
        `candles must be strictly increasing in time; bar ${i} at ${cur.time} follows ${prev.time}`,
      );
    }
  }
}
