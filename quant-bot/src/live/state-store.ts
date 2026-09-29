import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One symbol's position bookkeeping. */
export interface SymbolState {
  /** Open time of the last bar acted on for this symbol, so a restart cannot re-trade it. */
  lastBarTime: number;
  entryPrice: number | null;
  entryTime: number | null;
  stopPrice: number | null;
  highWaterPrice: number | null;
}

/**
 * Account-level fields live at the top: there is one kill switch and one
 * equity peak no matter how many symbols share the account, because a
 * drawdown is a property of the money, not of any one market.
 */
export interface RunnerState {
  peakEquity: number;
  /** Once true, the bot refuses to trade any symbol until a human clears the state file. */
  killed: boolean;
  killReason: string | null;
  /** Newest bar time the account-level risk check has already run for. */
  lastRiskBarTime: number;
  symbols: Record<string, SymbolState>;
}

export const EMPTY_SYMBOL_STATE: SymbolState = {
  lastBarTime: 0,
  entryPrice: null,
  entryTime: null,
  stopPrice: null,
  highWaterPrice: null,
};

export const EMPTY_STATE: RunnerState = {
  peakEquity: 0,
  killed: false,
  killReason: null,
  lastRiskBarTime: 0,
  symbols: {},
};

/**
 * Durable runner state.
 *
 * The kill switch in particular must outlive the process: a drawdown halt that
 * clears when the bot restarts is not a halt, it is a pause between attempts
 * at the same loss. Crash-restart loops are exactly when it matters most.
 */
export class StateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<RunnerState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
      const loaded = { ...EMPTY_STATE, ...(parsed as Partial<RunnerState>) };
      return { ...loaded, symbols: { ...loaded.symbols } };
    } catch {
      return { ...EMPTY_STATE, symbols: {} };
    }
  }

  /** Written via a temp file and rename so a crash mid-write cannot truncate it. */
  async save(state: RunnerState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, this.#path);
  }
}
