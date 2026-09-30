import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What the real account was worth when the live bot first started on it. */
export interface LiveBaseline {
  readonly startingEquity: number;
  readonly quote: string;
  readonly startedAt: string;
}

export async function readLiveBaseline(path: string): Promise<LiveBaseline | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LiveBaseline>;
    if (typeof parsed.startingEquity !== 'number' || typeof parsed.quote !== 'string') return null;
    return {
      startingEquity: parsed.startingEquity,
      quote: parsed.quote,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * Written once, on the first live start, and never overwritten: re-recording
 * on every restart would reset the profit/loss to zero each time the bot
 * crashed, hiding exactly the losses worth seeing.
 */
export async function recordLiveBaseline(
  path: string,
  equity: number,
  quote: string,
  now: Date = new Date(),
): Promise<LiveBaseline> {
  const existing = await readLiveBaseline(path);
  if (existing) return existing;
  const baseline: LiveBaseline = { startingEquity: equity, quote, startedAt: now.toISOString() };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(baseline, null, 2), 'utf8');
  await rename(tmp, path);
  return baseline;
}
