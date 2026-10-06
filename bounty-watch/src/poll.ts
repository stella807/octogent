import type { CantinaClient } from "./cantina-client.ts";
import type { BoardClient } from "./client.ts";
import type { Bounty, PollError, PollReport, WatchEntry, Watchlist } from "./domain/types.ts";
import { parseBoard } from "./parse.ts";
import type { SeenStore } from "./store.ts";

export interface PollOptions {
  readonly client: BoardClient;
  /** Required only when the watchlist has a Cantina entry. */
  readonly cantina?: CantinaClient;
  readonly store: SeenStore;
  readonly watchlist: Watchlist;
  /** Delay between board requests. Injectable so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly delayMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_DELAY_MS = 1_500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The same bounty can be posted on two boards, so identity is per board, not per URL. */
export function seenKey(bounty: Bounty): string {
  return `${bounty.org}::${bounty.id}`;
}

async function fetchEntry(options: PollOptions, entry: WatchEntry): Promise<Bounty[]> {
  if (entry.source === "cantina") {
    if (!options.cantina) throw new Error("no Cantina client configured");
    // Track programs under the entry's slug so pruning and seen keys stay per board.
    return (await options.cantina.fetchBounties()).map((bounty) => ({
      ...bounty,
      org: entry.slug,
    }));
  }
  return parseBoard(await options.client.fetchBoard(entry), entry.slug);
}

export async function pollOnce(options: PollOptions): Promise<PollReport> {
  const { store, watchlist } = options;
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const now = options.now ?? (() => new Date());

  const previous = await store.load();
  const open: Bounty[] = [];
  const errors: PollError[] = [];
  const polled = new Set<string>();

  for (const [index, entry] of watchlist.entries.entries()) {
    if (index > 0) await sleep(delayMs);

    try {
      const bounties = await fetchEntry(options, entry);
      polled.add(entry.slug);
      for (const bounty of bounties) {
        if (bounty.status !== "open") continue;
        if (bounty.amountUsd < watchlist.minAmountUsd) continue;
        open.push(bounty);
      }
    } catch (error) {
      errors.push({
        slug: entry.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fresh = open.filter((bounty) => !previous.has(seenKey(bounty)));

  // Only prune boards we actually reached. Dropping ids for a board that failed
  // would re-announce its whole backlog as new on the next successful poll.
  const retained = [...previous].filter((key) => !polled.has(key.slice(0, key.indexOf("::"))));
  await store.save([...retained, ...open.map(seenKey)]);

  return {
    polledAt: now().toISOString(),
    fresh,
    open,
    errors,
  };
}
