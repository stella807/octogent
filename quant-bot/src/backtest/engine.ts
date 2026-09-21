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
  readonly strategy: { readonly name: string; readonly params: Readonly<Record<string, number>> };
  readonly config: BacktestConfig;
  readonly equityCurve: readonly EquityPoint[];
  readonly trades: readonly Trade[];
  readonly startingEquity: number;
  readonly endingEquity: number;
  readonly firstHalt: HaltRecord | null;
  readonly barsTested: number;
}

type Pending =
  | { readonly kind: 'enter'; readonly stopPrice: number | undefined; readonly reason: string }
  | { readonly kind: 'exit'; readonly reason: string };

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
  let entryFee = 0;
  let entryEquity = 0;
  let firstHalt: HaltRecord | null = null;

  const closePosition = (
    fillPrice: number,
    time: number,
    barIndex: number,
    reason: ExitReason,
  ): void => {
    if (!position) return;
    const notional = position.qty * fillPrice;
    const exitFee = feeOn(notional, costs);
    cash += notional - exitFee;
    const cost = position.qty * position.entryPrice;
    const fees = entryFee + exitFee;
    const pnl = notional - cost - fees;
    trades.push({
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice: fillPrice,
      qty: position.qty,
      pnl,
      pnlPct: cost > 0 ? pnl / cost : 0,
      equityAtEntry: entryEquity,
      returnOnEquity: entryEquity > 0 ? pnl / entryEquity : 0,
      fees,
      exitReason: reason,
      barsHeld: barIndex - entryBar,
    });
    position = null;
    entryFee = 0;
  };

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;

    // 1. Fill whatever last bar's close decided, at this bar's open.
    if (pending) {
      if (pending.kind === 'enter' && position === null) {
        const fill = buyFillPrice(bar.open, costs);
        let qty = risk.sizePosition(cash, fill, pending.stopPrice);
        // Never spend cash we do not have: the fee rides on top of the notional.
        const affordable = cash / (fill * (1 + costs.feeBps / 10_000));
        qty = Math.min(qty, affordable);
        if (qty > 0 && Number.isFinite(qty)) {
          const notional = qty * fill;
          entryFee = feeOn(notional, costs);
          entryEquity = cash;
          cash -= notional + entryFee;
          entryBar = i;
          position = {
            qty,
            entryPrice: fill,
            entryTime: bar.time,
            stopPrice: pending.stopPrice,
            highWaterPrice: bar.open,
          };
        }
      } else if (pending.kind === 'exit' && position !== null) {
        closePosition(sellFillPrice(bar.open, costs), bar.time, i, 'signal');
      }
      pending = null;
    }

    // 2. Resting stop, checked against this bar's low.
    if (position !== null && position.stopPrice !== undefined && bar.low <= position.stopPrice) {
      const touched = bar.open <= position.stopPrice ? bar.open : position.stopPrice;
      closePosition(sellFillPrice(touched, costs), bar.time, i, 'stop');
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
        closePosition(sellFillPrice(bar.close, costs), bar.time, i, 'risk-halt');
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
      if (signal.target > 0 && position === null) {
        pending = { kind: 'enter', stopPrice: signal.stopPrice, reason: signal.reason ?? '' };
      } else if (signal.target <= 0 && position !== null) {
        pending = { kind: 'exit', reason: signal.reason ?? '' };
      } else if (position !== null && signal.stopPrice !== undefined) {
        // Stops ratchet up only. A stop that can be loosened is not a stop.
        const next = Math.max(position.stopPrice ?? signal.stopPrice, signal.stopPrice);
        position = { ...position, stopPrice: next };
      }
    }
  }

  if (position !== null && candles.length > 0) {
    const last = candles[candles.length - 1] as Candle;
    closePosition(sellFillPrice(last.close, costs), last.time, candles.length - 1, 'end-of-data');
  }

  return {
    strategy: { name: strategy.name, params: strategy.params },
    config,
    equityCurve,
    trades,
    startingEquity: config.startingEquity,
    endingEquity: cash,
    firstHalt,
    barsTested: candles.length,
  };
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
