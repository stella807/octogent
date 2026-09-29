import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ScreenRow } from './backtest/screen.ts';

export interface ScreenFile {
  readonly exchange: string;
  readonly strategy: string;
  readonly timeframe: string;
  readonly screenedAt: string;
  /** The symbols that passed, which `paper --symbols screened` trades. */
  readonly symbols: readonly string[];
  readonly rows: readonly ScreenRow[];
  /** Passes the same screen handed to the same markets with their days shuffled. */
  readonly luck?: LuckControl;
}

export interface LuckControl {
  readonly tested: number;
  readonly passed: number;
}

/** Kept next to the runner state, so one --state flag finds everything. */
export function screenPath(statePath: string): string {
  return join(dirname(statePath), 'screened.json');
}

export async function writeScreenFile(path: string, screen: ScreenFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(screen, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function readScreenFile(path: string): Promise<ScreenFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ScreenFile>;
    if (!Array.isArray(parsed.symbols) || typeof parsed.strategy !== 'string') return null;
    return parsed as ScreenFile;
  } catch {
    return null;
  }
}

export function formatScreen(
  rows: readonly ScreenRow[],
  strategy: string,
  exchange: string,
  luck?: LuckControl,
): string {
  const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  const eff = (v: number | null): string => (v === null ? '—' : v.toFixed(2));
  const passed = rows.filter((r) => r.passed).sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0));
  const tested = rows.filter((r) => r.efficiency !== null || r.oosTrades > 0).length;

  const lines = [
    `SCREEN  ${strategy} on ${exchange}: ${rows.length} markets, ${tested} with enough data to test`,
    '================================================================',
    `${'symbol'.padEnd(14)}${'efficiency'.padStart(11)}${'OOS return'.padStart(12)}${'OOS maxDD'.padStart(11)}${'trades'.padStart(8)}  verdict`,
  ];
  const ordered = [...passed, ...rows.filter((r) => !r.passed)];
  for (const r of ordered) {
    lines.push(
      `${r.symbol.padEnd(14)}${eff(r.efficiency).padStart(11)}${pct(r.oosReturnPct).padStart(12)}` +
      `${(r.oosMaxDrawdownPct === null ? '—' : `${r.oosMaxDrawdownPct.toFixed(2)}%`).padStart(11)}` +
      `${String(r.oosTrades).padStart(8)}  ${r.passed ? 'PASS' : 'fail'}: ${r.reason}`,
    );
  }
  lines.push('', `PASSED ${passed.length} of ${rows.length}: ${passed.map((r) => r.symbol).join(', ') || 'none'}`);
  if (luck) {
    const rate = luck.tested > 0 ? luck.passed / luck.tested : 0;
    const expected = rate * tested;
    lines.push(
      '',
      `LUCK CONTROL  the same markets with their days shuffled (every real pattern destroyed):`,
      `  ${luck.passed} of ${luck.tested} passed (${(rate * 100).toFixed(1)}%) — about ${expected.toFixed(1)} of the real`,
      `  ${tested} testable markets would pass on luck alone. Real passes: ${passed.length}.`,
      passed.length > expected * 2 && passed.length - expected >= 3
        ? '  The real screen passes clearly more than luck does.'
        : '  The real screen does not pass meaningfully more than luck: treat the list as noise.',
    );
  } else {
    lines.push('', 'Screening many markets lets some through on luck; run with --control to measure how many.');
  }
  lines.push(
    '',
    'A pass is permission to paper trade, not proof. Trade them with:',
    `  paper --exchange ${exchange} --strategy ${strategy} --symbols screened`,
  );
  return lines.join('\n');
}
