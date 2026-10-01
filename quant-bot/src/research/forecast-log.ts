import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './research.ts';

/**
 * A paper forecast log: a probability written down BEFORE the outcome is
 * known, next to the market's price at that moment, scored when the event
 * resolves. It is how to find out, with no money at risk, whether research
 * beats the posted prices. A handful of forecasts proves nothing either way.
 */

export interface Forecast {
  readonly id: string;
  readonly question: string;
  /** What `p` and `market` are the probability of, e.g. "Tulsa wins". */
  readonly outcome: string;
  readonly p: number;
  /** The market's no-spread probability of the same outcome when the forecast was written. */
  readonly market: number;
  readonly marketSource: string;
  readonly eventTime: string;
  readonly loggedAt: string;
  readonly note?: string;
  /** 1 if the outcome happened, 0 if not, null while pending. */
  readonly result: 0 | 1 | null;
  readonly resolvedAt?: string;
}

export type NewForecast = Omit<Forecast, 'loggedAt' | 'result' | 'resolvedAt'>;

export const brier = (p: number, outcome: 0 | 1): number => (p - outcome) ** 2;

const open01 = (v: number): boolean => Number.isFinite(v) && v > 0 && v < 1;

export function addForecast(list: readonly Forecast[], input: NewForecast, now: string): Forecast[] {
  if (!input.id) throw new Error('forecast needs an id');
  if (!input.question) throw new Error('forecast needs a question');
  if (!input.outcome) throw new Error('forecast needs the outcome its probability refers to');
  if (list.some((f) => f.id === input.id)) throw new Error(`forecast "${input.id}" already exists`);
  if (!open01(input.p) || !open01(input.market)) throw new RangeError('probabilities must be between 0 and 1, exclusive');
  return [...list, { ...input, loggedAt: now, result: null }];
}

export function resolveForecast(list: readonly Forecast[], id: string, happened: boolean, now: string): Forecast[] {
  const target = list.find((f) => f.id === id);
  if (!target) throw new Error(`no forecast "${id}"`);
  if (target.result !== null) throw new Error(`forecast "${id}" is already resolved`);
  return list.map((f) => (f.id === id ? { ...f, result: happened ? 1 : 0, resolvedAt: now } : f));
}

export interface ForecastScore {
  readonly resolved: number;
  readonly pending: number;
  readonly mine: number | null;
  readonly market: number | null;
  /** Number of resolved forecasts where my probability was closer to what happened than the market's. */
  readonly mineBeatMarket: number;
}

export function scoreForecasts(list: readonly Forecast[]): ForecastScore {
  const done = list.filter((f): f is Forecast & { result: 0 | 1 } => f.result !== null);
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    resolved: done.length,
    pending: list.length - done.length,
    mine: mean(done.map((f) => brier(f.p, f.result))),
    market: mean(done.map((f) => brier(f.market, f.result))),
    mineBeatMarket: done.filter((f) => brier(f.p, f.result) < brier(f.market, f.result)).length,
  };
}

export async function loadForecasts(path: string): Promise<Forecast[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Forecast[]) : [];
  } catch {
    return [];
  }
}

export const saveForecasts = (path: string, list: readonly Forecast[]): Promise<void> => writeJsonAtomic(path, list);

export function formatForecasts(list: readonly Forecast[]): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines = ['PAPER FORECAST LOG  (no money at risk; a probability written down before the result, scored against the market)', '='.repeat(86)];
  for (const f of list) {
    const result = f.result === null ? 'pending' : f.result === 1 ? 'HAPPENED' : 'did not happen';
    lines.push(`  ${f.id.padEnd(14)} ${f.outcome.padEnd(22)} mine ${pct(f.p).padStart(6)}  market ${pct(f.market).padStart(6)} (${f.marketSource})  ${f.eventTime.slice(0, 16)}Z  ${result}`);
  }
  const s = scoreForecasts(list);
  lines.push('');
  if (s.resolved === 0) {
    lines.push(`${s.pending} pending, none resolved yet.`);
  } else {
    lines.push(`Resolved ${s.resolved}: my Brier ${(s.mine as number).toFixed(3)} vs market ${(s.market as number).toFixed(3)} (lower is better); closer than the market on ${s.mineBeatMarket} of ${s.resolved}.`);
  }
  lines.push('A handful of forecasts cannot show skill: one result is mostly luck. It takes dozens, and beating the market consistently is rare.');
  return lines.join('\n');
}
