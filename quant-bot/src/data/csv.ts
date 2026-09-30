import { readFile } from 'node:fs/promises';
import type { Candle } from '../domain/types.ts';

/**
 * Reads `timestamp,open,high,low,close,volume`, with or without a header.
 * Timestamps may be epoch seconds, epoch milliseconds, or ISO 8601.
 *
 * With a header, columns are found by name instead, so a TradingView "Export
 * chart data" file loads as-is: `time,open,high,low,close,Volume` plus any
 * indicator columns, which are ignored. A missing Volume column (TradingView
 * omits it unless the volume indicator is on the chart) reads as zero.
 */
export async function loadCsv(path: string): Promise<Candle[]> {
  return parseCsv(await readFile(path, 'utf8'));
}

type Column = 'time' | 'open' | 'high' | 'low' | 'close' | 'volume';
const POSITIONAL: Record<Column, number> = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
const NAMES: Record<Column, readonly string[]> = {
  time: ['time', 'timestamp', 'date', 'datetime'],
  open: ['open'],
  high: ['high'],
  low: ['low'],
  close: ['close'],
  volume: ['volume', 'vol'],
};

/** Column positions from a header row, or null if the row is not a recognisable header. */
function headerColumns(cells: readonly string[]): Record<Column, number | null> | null {
  const lower = cells.map((c) => c.toLowerCase().replace(/^"|"$/g, ''));
  const find = (col: Column): number | null => {
    const i = lower.findIndex((c) => NAMES[col].includes(c));
    return i >= 0 ? i : null;
  };
  const cols = { time: find('time'), open: find('open'), high: find('high'), low: find('low'), close: find('close'), volume: find('volume') };
  const required: Column[] = ['time', 'open', 'high', 'low', 'close'];
  return required.every((c) => cols[c] !== null) ? cols : null;
}

export function parseCsv(text: string): Candle[] {
  const candles: Candle[] = [];
  const lines = text.split(/\r?\n/);
  let columns: Record<Column, number | null> | null = null;
  for (const [lineNo, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const cells = trimmed.split(',').map((c) => c.trim());
    if (candles.length === 0 && columns === null) {
      const header = headerColumns(cells);
      if (header) {
        columns = header;
        continue;
      }
    }
    const cols = columns ?? POSITIONAL;
    if (columns === null && cells.length < 6) {
      throw new Error(`line ${lineNo + 1}: expected 6 columns, got ${cells.length}`);
    }
    const cell = (col: Column): string | undefined => {
      const i = cols[col];
      return i === null ? undefined : cells[i];
    };
    const time = parseTime(cell('time') ?? '');
    if (time === null) {
      if (candles.length === 0 && columns === null) continue; // unrecognised header row
      throw new Error(`line ${lineNo + 1}: unparseable timestamp "${cell('time')}"`);
    }
    const volumeCell = cell('volume');
    const [open, high, low, close, volume] = [
      Number(cell('open')), Number(cell('high')), Number(cell('low')), Number(cell('close')),
      volumeCell === undefined || volumeCell === '' ? 0 : Number(volumeCell),
    ];
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
