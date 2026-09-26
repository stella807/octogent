import { readFile } from 'node:fs/promises';
import type { Candle } from '../domain/types.ts';

const COLUMNS = ['timestamp', 'open', 'high', 'low', 'close', 'volume'] as const;

/** Epoch values below this are seconds; above it, milliseconds (year 5138 in seconds). */
const SECONDS_CUTOFF = 1e11;

export async function loadCsv(path: string): Promise<Candle[]> {
  return parseCsv(await readFile(path, 'utf8'));
}

/**
 * Parses `timestamp,open,high,low,close,volume` rows. Timestamps may be epoch
 * seconds, epoch milliseconds, or ISO strings. An optional header row, blank
 * lines, and `#` comments are skipped.
 *
 * It is strict on purpose: a bad row throws with its line number rather than
 * becoming NaN or a malformed bar, because a high below the open fakes stop
 * fills and a NaN close poisons every metric downstream without an error.
 */
export function parseCsv(text: string): Candle[] {
  const candles: Candle[] = [];
  const lines = text.split(/\r?\n/);
  let seenData = false;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const lineNo = index + 1;
    const fields = line.split(',').map((f) => f.trim());

    if (!seenData && isHeader(fields)) {
      seenData = true;
      return;
    }
    seenData = true;

    if (fields.length < COLUMNS.length) {
      throw new Error(`line ${lineNo}: expected ${COLUMNS.length} columns (${COLUMNS.join(',')}), got ${fields.length}`);
    }

    const time = parseTimestamp(fields[0] ?? '', lineNo);
    const [open, high, low, close, volume] = COLUMNS.slice(1).map((name, i) =>
      parseNumber(fields[i + 1] ?? '', name, lineNo)) as [number, number, number, number, number];

    if (high < Math.max(open, close, low) || low > Math.min(open, close) || low <= 0) {
      throw new Error(`line ${lineNo}: inconsistent OHLC (open ${open}, high ${high}, low ${low}, close ${close})`);
    }
    if (volume < 0) throw new Error(`line ${lineNo}: volume must not be negative, got ${volume}`);

    candles.push({ time, open, high, low, close, volume });
  });

  // Exports are not always chronological; the engine assumes they are.
  candles.sort((a, b) => a.time - b.time);
  for (let i = 1; i < candles.length; i += 1) {
    if (candles[i]?.time === candles[i - 1]?.time) {
      throw new Error(`duplicate timestamp ${new Date(candles[i]?.time ?? 0).toISOString()}`);
    }
  }
  return candles;
}

/**
 * A header is a first row whose timestamp column is not a timestamp. Judging by
 * the price columns instead would swallow a lone malformed data row silently.
 */
function isHeader(fields: readonly string[]): boolean {
  const first = fields[0] ?? '';
  return !/^\d/.test(first) && !Number.isFinite(Date.parse(first));
}

function parseTimestamp(value: string, lineNo: number): number {
  if (/^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    return n < SECONDS_CUTOFF ? Math.round(n * 1000) : Math.round(n);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`line ${lineNo}: timestamp "${value}" is not epoch seconds, epoch ms, or ISO 8601`);
  }
  return parsed;
}

function parseNumber(value: string, name: string, lineNo: number): number {
  const n = value === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(n)) throw new Error(`line ${lineNo}: ${name} "${value}" is not a finite number`);
  return n;
}
