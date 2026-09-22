import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RunnerState {
  /** Open time of the last bar the runner acted on, so a restart cannot re-trade it. */
  lastBarTime: number;
  entryPrice: number | null;
  entryTime: number | null;
  stopPrice: number | null;
  highWaterPrice: number | null;
  peakEquity: number;
  /** Once true, the bot refuses to trade until a human clears the state file. */
  killed: boolean;
  killReason: string | null;
}

export const EMPTY_STATE: RunnerState = {
  lastBarTime: 0,
  entryPrice: null,
  entryTime: null,
  stopPrice: null,
  highWaterPrice: null,
  peakEquity: 0,
  killed: false,
  killReason: null,
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
      return { ...EMPTY_STATE, ...(parsed as Partial<RunnerState>) };
    } catch {
      return { ...EMPTY_STATE };
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
