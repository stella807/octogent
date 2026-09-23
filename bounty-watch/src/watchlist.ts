import { readFile } from "node:fs/promises";
import type { WatchEntry, Watchlist } from "./domain/types.ts";

const DEFAULT_MIN_AMOUNT_USD = 50;

export class WatchlistError extends Error {}

/** Parse a watchlist config, rejecting shapes that would silently poll nothing. */
export function parseWatchlist(raw: unknown): Watchlist {
  if (typeof raw !== "object" || raw === null) {
    throw new WatchlistError("watchlist must be a JSON object");
  }

  const source = raw as { entries?: unknown; minAmountUsd?: unknown };
  if (!Array.isArray(source.entries) || source.entries.length === 0) {
    throw new WatchlistError("watchlist.entries must be a non-empty array");
  }

  const entries: WatchEntry[] = source.entries.map((value, index) => {
    if (typeof value === "string") return { slug: value };
    if (typeof value !== "object" || value === null) {
      throw new WatchlistError(`watchlist.entries[${index}] must be a string or object`);
    }
    const entry = value as { slug?: unknown; path?: unknown };
    if (typeof entry.slug !== "string" || entry.slug.trim() === "") {
      throw new WatchlistError(`watchlist.entries[${index}].slug must be a non-empty string`);
    }
    return typeof entry.path === "string"
      ? { slug: entry.slug, path: entry.path }
      : { slug: entry.slug };
  });

  const minAmountUsd =
    typeof source.minAmountUsd === "number" &&
    Number.isFinite(source.minAmountUsd) &&
    source.minAmountUsd >= 0
      ? source.minAmountUsd
      : DEFAULT_MIN_AMOUNT_USD;

  return { entries, minAmountUsd };
}

export async function loadWatchlist(path: string): Promise<Watchlist> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new WatchlistError(`cannot read watchlist at ${path}`);
  }
  try {
    return parseWatchlist(JSON.parse(raw));
  } catch (error) {
    if (error instanceof WatchlistError) throw error;
    throw new WatchlistError(`watchlist at ${path} is not valid JSON`);
  }
}
