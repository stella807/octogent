import { dirname, join } from 'node:path';
import type { PaperAccount } from './paper-broker.ts';
import type { RunnerState } from './state-store.ts';

/** The paper account sits next to the runner state, so one --state flag locates both. */
export function paperAccountPath(statePath: string): string {
  return join(dirname(statePath), 'paper-account.json');
}

export interface PositionStatus {
  readonly symbol: string;
  readonly qty: number;
  readonly entryPrice: number | null;
  readonly stopPrice: number | null;
  /** Null when the current price could not be fetched. */
  readonly price: number | null;
  /** Marked at the current price, or at entry when no price could be fetched. */
  readonly value: number | null;
  readonly unrealized: number | null;
}

export interface PaperStatus {
  readonly startingCash: number;
  readonly cash: number;
  /** Cash plus every position that could be priced. */
  readonly equity: number;
  /** True when some position could not be priced and is carried at its entry price. */
  readonly partial: boolean;
  readonly pnl: number;
  readonly pnlPct: number;
  readonly buys: number;
  readonly sells: number;
  readonly feesPaid: number;
  readonly positions: readonly PositionStatus[];
  /** Realized profit/loss per symbol from completed buy→sell round trips. */
  readonly realizedBySymbol: Readonly<Record<string, number>>;
  readonly killed: boolean;
  readonly killReason: string | null;
}

export function paperStatus(
  account: PaperAccount,
  state: RunnerState,
  prices: Readonly<Record<string, number | null>>,
): PaperStatus {
  const positions: PositionStatus[] = Object.entries(account.holdings)
    .filter(([, qty]) => qty > 0)
    .map(([symbol, qty]) => {
      const price = prices[symbol] ?? null;
      const entryPrice = state.symbols[symbol]?.entryPrice ?? null;
      return {
        symbol,
        qty,
        entryPrice,
        stopPrice: state.symbols[symbol]?.stopPrice ?? null,
        price,
        // An unpriced position is still held: counting it as zero would report
        // its whole value as a loss. Entry price is the neutral stand-in.
        value: price !== null ? qty * price : entryPrice !== null ? qty * entryPrice : null,
        unrealized: price !== null && entryPrice !== null ? qty * (price - entryPrice) : null,
      };
    });
  const equity = account.cash + positions.reduce((sum, p) => sum + (p.value ?? 0), 0);
  const pnl = equity - account.startingCash;
  return {
    startingCash: account.startingCash,
    cash: account.cash,
    equity,
    partial: positions.some((p) => p.price === null),
    pnl,
    pnlPct: account.startingCash > 0 ? (pnl / account.startingCash) * 100 : 0,
    buys: account.fills.filter((f) => f.side === 'buy').length,
    sells: account.fills.filter((f) => f.side === 'sell').length,
    feesPaid: account.fills.reduce((sum, f) => sum + f.fee, 0),
    positions,
    realizedBySymbol: realizedBySymbol(account),
    killed: state.killed,
    killReason: state.killReason,
  };
}

/** Cash out minus cash in per symbol, counting only fully closed round trips. */
function realizedBySymbol(account: PaperAccount): Record<string, number> {
  const out: Record<string, number> = {};
  const open: Record<string, { qty: number; cost: number }> = {};
  for (const f of account.fills) {
    const lot = (open[f.symbol] ??= { qty: 0, cost: 0 });
    if (f.side === 'buy') {
      lot.qty += f.qty;
      lot.cost += f.qty * f.price + f.fee;
      continue;
    }
    const share = lot.qty > 0 ? Math.min(1, f.qty / lot.qty) : 1;
    const basis = lot.cost * share;
    out[f.symbol] = (out[f.symbol] ?? 0) + f.qty * f.price - f.fee - basis;
    lot.qty -= f.qty;
    lot.cost -= basis;
  }
  return out;
}

export function formatPaperStatus(s: PaperStatus): string {
  const money = (v: number): string => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
  const signed = (v: number): string => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  const lines = [
    'PAPER ACCOUNT  (simulated — no real money)',
    '================================================================',
    `  Starting cash                ${money(s.startingCash)}`,
    `  Cash now                     ${money(s.cash)}`,
    `  Equity now                   ${money(s.equity)}${s.partial ? '  (some positions unpriced; carried at entry price)' : ''}`,
    `  Profit / loss                ${signed(s.pnl)}  (${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct.toFixed(2)}%)`,
    `  Fills                        ${s.buys} buys, ${s.sells} sells, ${money(s.feesPaid)} in fees`,
  ];

  lines.push('', s.positions.length > 0 ? `OPEN POSITIONS (${s.positions.length})` : 'No open positions.');
  for (const p of s.positions) {
    lines.push(
      `  ${p.symbol.padEnd(12)} ${p.qty.toFixed(8)}` +
      `  entry ${p.entryPrice !== null ? money(p.entryPrice) : '?'}` +
      `  now ${p.price !== null ? money(p.price) : 'unavailable'}` +
      `  stop ${p.stopPrice !== null ? money(p.stopPrice) : 'none'}` +
      `  unrealized ${p.unrealized !== null ? signed(p.unrealized) : 'unavailable'}`,
    );
  }

  const closed = Object.entries(s.realizedBySymbol);
  if (closed.length > 0) {
    lines.push('', 'CLOSED TRADES, BY SYMBOL');
    for (const [symbol, pnl] of closed.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${symbol.padEnd(12)} ${signed(pnl)}`);
    }
  }
  if (s.killed) {
    lines.push('', `KILL SWITCH ACTIVE: ${s.killReason ?? 'unknown'}. Trading halted until the state file is cleared.`);
  }
  if (s.buys === 0) {
    lines.push('', 'No trades yet. Low-frequency strategies can wait days or weeks for a signal.');
  }
  return lines.join('\n');
}
