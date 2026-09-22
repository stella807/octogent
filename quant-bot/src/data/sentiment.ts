import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Candle } from '../domain/types.ts';

export interface SentimentPoint {
  /** UTC midnight of the day this reading covers. */
  readonly time: number;
  /** 0 (extreme fear) to 100 (extreme greed). */
  readonly value: number;
}

interface RawEntry {
  readonly value: string;
  readonly timestamp: string;
}

const DAY_MS = 86_400_000;
const ENDPOINT = 'https://api.alternative.me/fng/?limit=0&format=json';

/**
 * The crypto Fear & Greed Index (alternative.me): a market-wide 0-100 reading
 * aggregated daily from volatility, momentum, volume, social media and
 * surveys. It is one signal, not a strategy on its own — this repo treats it
 * the same as any other input, subject to the same causality rule and the
 * same walk-forward test everything else is held to.
 *
 * Cached to disk because it is a free public API with no key and no SLA; a
 * cached copy keeps repeated runs reproducible even if the endpoint changes
 * or goes down.
 */
export async function fetchSentiment(cacheDir = 'data/cache'): Promise<SentimentPoint[]> {
  const cachePath = join(cacheDir, 'fear-greed-index.json');
  const cached = await readCache(cachePath);
  if (cached) return cached;

  const response = await fetch(ENDPOINT);
  if (!response.ok) {
    throw new Error(`fear/greed index request failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data: RawEntry[] };
  const points: SentimentPoint[] = body.data
    .map((entry) => ({
      // The API's own timestamps land on UTC midnight already; floor defends
      // against a future response that doesn't.
      time: Math.floor((Number(entry.timestamp) * 1000) / DAY_MS) * DAY_MS,
      value: Number(entry.value),
    }))
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.time - b.time);

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(points), 'utf8');
  return points;
}

/**
 * Aligns sentiment to candles with a one-day lag: bar `i` sees the reading
 * published for the PRIOR day, never the same day.
 *
 * The index API does not document the exact intraday time each day's value
 * is finalized, only that it updates once daily. Using the same-day reading
 * risks a signal partly computed from hours after the bar it would be traded
 * on — a lookahead bug that would not show up in any test with daily
 * resolution timestamps, because both sides "match" by date. Lagging by a
 * full day costs at most one day of staleness and removes the risk entirely;
 * `test/sentiment.test.ts` asserts the alignment never reaches into the
 * future relative to the bar.
 */
export function alignSentiment(
  candles: readonly Candle[],
  sentiment: readonly SentimentPoint[],
): (number | null)[] {
  const byDay = new Map(sentiment.map((p) => [p.time, p.value]));
  return candles.map((candle) => {
    const priorDay = Math.floor(candle.time / DAY_MS) * DAY_MS - DAY_MS;
    return byDay.get(priorDay) ?? null;
  });
}

async function readCache(path: string): Promise<SentimentPoint[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as SentimentPoint[]) : null;
  } catch {
    return null;
  }
}
