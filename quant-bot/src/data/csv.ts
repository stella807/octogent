import { readFile } from 'node:fs/promises';
import type { Candle } from '../domain/types.ts';

/**
 * Reads `timestamp,open,high,low,close,volume`, with or without a header.
 * Timestamps may be epoch seconds, epoch milliseconds, or ISO 8601.
 */
export async function loadCsv(path: string): Promise<Candle[]> {
  return parseCsv(await readFile(path, 'utf8'));
}

export function parseCsv(text: string): Candle[] {
  const candles: Candle[] = [];
  const lines = text.split(/\r?\n/);
  for (const [lineNo, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const cells = trimmed.split(',').map((c) => c.trim());
    if (cells.length < 6) {
      throw new Error(`line ${lineNo + 1}: expected 6 columns, got ${cells.length}`);
    }
    const time = parseTime(cells[0] as string);
    if (time === null) {
      if (candles.length === 0) continue; // header row
      throw new Error(`line ${lineNo + 1}: unparseable timestamp "${cells[0]}"`);
    }
    const [open, high, low, close, volume] = cells.slice(1, 6).map(Number);
    const values = { open, high, low, close, volume };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || !Number.isFinite(value)) {
        throw new Error(`line ${lineNo + 1}: ${key} is not a finite number`);
      }
    }
    const candle: Candle = {
      time,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
    };
    // Bad OHLC relationships silently corrupt stop fills, so reject them here
    // rather than discovering them as an impossibly good backtest later.
    if (candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)) {
      throw new Error(`line ${lineNo + 1}: inconsistent OHLC (high ${candle.high}, low ${candle.low})`);
    }
    candles.push(candle);
  }
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

function parseTime(cell: string): number | null {
  if (/^\d+$/.test(cell)) {
    const n = Number(cell);
    // 10 digits is epoch seconds, 13 is milliseconds.
    return cell.length <= 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(cell);
  return Number.isNaN(parsed) ? null : parsed;
}
