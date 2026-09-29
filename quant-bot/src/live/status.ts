import { dirname, join } from 'node:path';
import type { PaperAccount } from './paper-broker.ts';
import type { RunnerState } from './state-store.ts';

/** The paper account sits next to the runner state, so one --state flag locates both. */
export function paperAccountPath(statePath: string): string {
  return join(dirname(statePath), 'paper-account.json');
}

export interface PaperStatus {
  readonly startingCash: number;
  readonly cash: number;
  readonly qty: number;
  /** Null when the current price could not be fetched; equity is then cash-only. */
  readonly price: number | null;
  readonly equity: number;
  readonly pnl: number;
  readonly pnlPct: number;
  readonly buys: number;
  readonly sells: number;
  readonly feesPaid: number;
  readonly open: {
    readonly entryPrice: number;
    readonly stopPrice: number | null;
    readonly unrealized: number | null;
  } | null;
  readonly killed: boolean;
  readonly killReason: string | null;
}

export function paperStatus(
  account: PaperAccount,
  state: RunnerState,
  price: number | null,
): PaperStatus {
  const holding = account.qty > 0;
  const equity = account.cash + (holding && price !== null ? account.qty * price : 0);
  const pnl = equity - account.startingCash;
  return {
    startingCash: account.startingCash,
    cash: account.cash,
    qty: account.qty,
    price,
    equity,
    pnl,
    pnlPct: account.startingCash > 0 ? (pnl / account.startingCash) * 100 : 0,
    buys: account.fills.filter((f) => f.side === 'buy').length,
    sells: account.fills.filter((f) => f.side === 'sell').length,
    feesPaid: account.fills.reduce((sum, f) => sum + f.fee, 0),
    open: holding && state.entryPrice !== null
      ? {
        entryPrice: state.entryPrice,
        stopPrice: state.stopPrice,
        unrealized: price !== null ? account.qty * (price - state.entryPrice) : null,
      }
      : null,
    killed: state.killed,
    killReason: state.killReason,
  };
}

export function formatPaperStatus(s: PaperStatus, symbol: string): string {
  const money = (v: number): string => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
  const signed = (v: number): string => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  const lines = [
    `PAPER ACCOUNT  ${symbol}  (simulated — no real money)`,
    '================================================================',
    `  Starting cash                ${money(s.startingCash)}`,
    `  Equity now                   ${money(s.equity)}${s.price === null && s.qty > 0 ? '  (price unavailable; position not marked)' : ''}`,
    `  Profit / loss                ${signed(s.pnl)}  (${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct.toFixed(2)}%)`,
    `  Fills                        ${s.buys} buys, ${s.sells} sells, ${money(s.feesPaid)} in fees`,
  ];
  if (s.open) {
    lines.push(
      '',
      'OPEN POSITION',
      `  Holding                      ${s.qty.toFixed(8)}`,
      `  Entry                        ${money(s.open.entryPrice)}`,
      `  Price now                    ${s.price !== null ? money(s.price) : 'unavailable'}`,
      `  Stop                         ${s.open.stopPrice !== null ? money(s.open.stopPrice) : 'none'}`,
      `  Unrealized                   ${s.open.unrealized !== null ? signed(s.open.unrealized) : 'unavailable'}`,
    );
  } else {
    lines.push('', 'No open position.');
  }
  if (s.killed) {
    lines.push('', `KILL SWITCH ACTIVE: ${s.killReason ?? 'unknown'}. Trading halted until the state file is cleared.`);
  }
  if (s.buys === 0) {
    lines.push('', 'No trades yet. Low-frequency strategies can wait days or weeks for a signal.');
  }
  return lines.join('\n');
}
