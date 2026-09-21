import type { Candle, EquityPoint, ExitReason, Trade } from '../domain/types.ts';
import { buyFillPrice, feeOn, sellFillPrice } from '../backtest/costs.ts';
import type { BacktestConfig, BacktestResult, HaltRecord } from '../backtest/engine.ts';
import { RiskManager } from '../risk/risk-manager.ts';
import type { AlignedSeries } from './align.ts';
import type { PortfolioStrategy } from './types.ts';

export interface PortfolioTrade extends Trade {
  readonly symbol: string;
}

export interface PortfolioResult extends Omit<BacktestResult, 'trades'> {
  readonly trades: readonly PortfolioTrade[];
  readonly symbols: readonly string[];
  /** Per-symbol contribution to total P&L, in quote currency. */
  readonly contribution: Readonly<Record<string, number>>;
}

interface Holding {
  qty: number;
  entryPrice: number;
  entryTime: number;
  entryBar: number;
  realizedPnl: number;
  feesPaid: number;
  peakQty: number;
  equityAtEntry: number;
}

/**
 * Weight moves smaller than this are not worth the round trip. Rebalancing on
 * every drift is the classic way a diversified portfolio underperforms its own
 * components: the fees are small individually and enormous in aggregate.
 */
const MIN_WEIGHT_MOVE = 0.02;

/**
 * Multi-asset backtest, under the same causality rule as the single-asset
 * engine: weights computed from the close of bar `i` are filled at the open of
 * bar `i+1`, across every symbol at once.
 *
 * Diversification is the only thing in this repo that improves returns without
 * costing something elsewhere. One asset's drawdown is the strategy's
 * drawdown; eight uncorrelated assets' drawdowns partially cancel. Crypto is
 * far from uncorrelated — in a real crash everything falls together — so the
 * benefit is real but much smaller than the textbook suggests, which is why
 * the report prints per-symbol contribution rather than just the total.
 */
export function runPortfolioBacktest(
  series: AlignedSeries,
  strategy: PortfolioStrategy,
  config: BacktestConfig,
): PortfolioResult {
  if (config.startingEquity <= 0) {
    throw new RangeError(`startingEquity must be > 0, got ${config.startingEquity}`);
  }
  const { costs } = config;
  const n = series.times.length;
  const count = series.symbols.length;
  const risk = new RiskManager(config.startingEquity, config.limits);

  let cash = config.startingEquity;
  const holdings: (Holding | null)[] = new Array(count).fill(null);
  const trades: PortfolioTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const contribution: Record<string, number> = Object.fromEntries(
    series.symbols.map((s) => [s, 0]),
  );
  let pending: readonly number[] | null = null;
  let rejectedOrders = 0;
  let lastWeights: number[] = new Array(count).fill(0);
  let firstHalt: HaltRecord | null = null;

  const barAt = (s: number, i: number): Candle => (series.bars[s] as readonly Candle[])[i] as Candle;

  const sell = (s: number, qty: number, price: number, i: number, reason: ExitReason): void => {
    const holding = holdings[s];
    if (!holding || qty <= 0) return;
    const sellQty = Math.min(qty, holding.qty);
    const notional = sellQty * price;
    // Same exchange minimum the single-asset engine enforces; the end-of-data
    // liquidation is an accounting close rather than an order, so it is exempt.
    if (reason !== 'end-of-data' && notional < costs.minOrderNotional) {
      rejectedOrders += 1;
      return;
    }
    const fee = feeOn(notional, costs);
    cash += notional - fee;
    holding.realizedPnl += sellQty * (price - holding.entryPrice);
    holding.feesPaid += fee;
    holding.qty -= sellQty;
    if (holding.qty > 1e-12) return;

    const pnl = holding.realizedPnl - holding.feesPaid;
    const basis = holding.peakQty * holding.entryPrice;
    const symbol = series.symbols[s] as string;
    trades.push({
      symbol,
      entryTime: holding.entryTime,
      exitTime: series.times[i] as number,
      entryPrice: holding.entryPrice,
      exitPrice: price,
      qty: holding.peakQty,
      pnl,
      pnlPct: basis > 0 ? pnl / basis : 0,
      equityAtEntry: holding.equityAtEntry,
      returnOnEquity: holding.equityAtEntry > 0 ? pnl / holding.equityAtEntry : 0,
      fees: holding.feesPaid,
      exitReason: reason,
      barsHeld: i - holding.entryBar,
    });
    contribution[symbol] = (contribution[symbol] ?? 0) + pnl;
    holdings[s] = null;
  };

  const buy = (s: number, wantQty: number, price: number, i: number, equityNow: number): void => {
    if (wantQty <= 0 || !Number.isFinite(wantQty) || price <= 0) return;
    // Clamp to what cash actually covers rather than rejecting the order. The
    // 1-ULP shrink matters: a fully-invested target computes a quantity whose
    // notional plus fee rounds a hair above cash, and a strict `>` comparison
    // would silently decline to trade at all.
    const maxQty = (cash / (price * (1 + costs.feeBps / 10_000))) * (1 - 1e-12);
    const qty = Math.min(wantQty, maxQty);
    if (qty <= 0) return;
    const notional = qty * price;
    if (notional < costs.minOrderNotional) {
      rejectedOrders += 1;
      return;
    }
    const fee = feeOn(notional, costs);
    cash -= notional + fee;
    const holding = holdings[s];
    if (!holding) {
      holdings[s] = {
        qty,
        entryPrice: price,
        entryTime: series.times[i] as number,
        entryBar: i,
        realizedPnl: 0,
        feesPaid: fee,
        peakQty: qty,
        equityAtEntry: equityNow,
      };
      return;
    }
    const total = holding.qty + qty;
    holding.entryPrice = (holding.qty * holding.entryPrice + notional) / total;
    holding.qty = total;
    holding.feesPaid += fee;
    holding.peakQty = Math.max(holding.peakQty, total);
  };

  for (let i = 0; i < n; i += 1) {
    // 1. Rebalance to the weights decided at the last close, at this bar's opens.
    if (pending) {
      const opens = series.symbols.map((_, s) => barAt(s, i).open);
      const equity = cash + holdings.reduce(
        (acc, h, s) => acc + (h ? h.qty * (opens[s] as number) : 0),
        0,
      );
      const desired = normalise(pending);

      // Sells first: they free the cash the buys are about to need.
      for (let s = 0; s < count; s += 1) {
        const open = opens[s] as number;
        const held = holdings[s]?.qty ?? 0;
        const targetQty = (equity * (desired[s] as number)) / open;
        const delta = targetQty - held;
        if (delta < 0 && Math.abs(delta) * open >= equity * MIN_WEIGHT_MOVE) {
          sell(s, -delta, sellFillPrice(open, costs), i, 'signal');
        }
      }
      for (let s = 0; s < count; s += 1) {
        const open = opens[s] as number;
        const price = buyFillPrice(open, costs);
        const held = holdings[s]?.qty ?? 0;
        const targetQty = (equity * (desired[s] as number)) / price;
        const delta = targetQty - held;
        if (delta > 0 && delta * price >= equity * MIN_WEIGHT_MOVE) {
          buy(s, delta, price, i, equity);
        }
      }
      lastWeights = [...desired];
      pending = null;
    }

    // 2. Mark to market.
    let invested = 0;
    for (let s = 0; s < count; s += 1) {
      const holding = holdings[s];
      if (holding) invested += holding.qty * barAt(s, i).close;
    }
    const equity = cash + invested;
    equityCurve.push({
      time: series.times[i] as number,
      equity,
      exposure: equity > 0 ? invested / equity : 0,
    });

    // 3. Risk limits, evaluated on total equity across every holding.
    const state = risk.onBar(series.times[i] as number, equity);
    if (state.flatten) {
      for (let s = 0; s < count; s += 1) {
        const holding = holdings[s];
        if (holding) {
          sell(s, holding.qty, sellFillPrice(barAt(s, i).close, costs), i, 'risk-halt');
        }
      }
      if (firstHalt === null) {
        firstHalt = { kind: state.halt, reason: state.reason, time: series.times[i] as number };
      }
      lastWeights = new Array(count).fill(0);
      pending = null;
      continue;
    }

    // 4. Ask for new weights; act only when one has moved materially.
    if (i >= strategy.warmup && i < n - 1) {
      const weights = normalise(strategy.weightsAt(i));
      const moved = weights.some((w, s) => Math.abs(w - (lastWeights[s] ?? 0)) >= MIN_WEIGHT_MOVE);
      if (moved) pending = weights;
    }
  }

  if (n > 0) {
    for (let s = 0; s < count; s += 1) {
      const holding = holdings[s];
      if (holding) {
        sell(s, holding.qty, sellFillPrice(barAt(s, n - 1).close, costs), n - 1, 'end-of-data');
      }
    }
  }

  return {
    strategy: { name: strategy.name, params: strategy.params },
    config,
    symbols: series.symbols,
    equityCurve,
    trades,
    contribution,
    startingEquity: config.startingEquity,
    endingEquity: cash,
    firstHalt,
    rejectedOrders,
    barsTested: n,
  };
}

/**
 * Clamps weights into [0, 1] and scales them down if they sum above 1.
 * Scaling rather than throwing keeps a strategy's relative intent intact while
 * refusing to act on leverage it is not allowed to use.
 */
export function normalise(weights: readonly number[]): number[] {
  const clamped = weights.map((w) => (Number.isFinite(w) ? Math.max(w, 0) : 0));
  const total = clamped.reduce((a, w) => a + w, 0);
  return total > 1 ? clamped.map((w) => w / total) : clamped;
}

/** Adapts a portfolio result to the shape `computeMetrics` expects. */
export function asBacktestResult(result: PortfolioResult): BacktestResult {
  return { ...result, trades: result.trades };
}
