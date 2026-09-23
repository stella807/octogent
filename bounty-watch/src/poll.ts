import type { BoardClient } from "./client.ts";
import type { Bounty, PollError, PollReport, Watchlist } from "./domain/types.ts";
import type { IssueStateClient } from "./liveness.ts";
import { filterLive } from "./liveness.ts";
import { parseBoard } from "./parse.ts";
import type { SeenStore } from "./store.ts";

export interface PollOptions {
  readonly client: BoardClient;
  readonly store: SeenStore;
  readonly watchlist: Watchlist;
  /** When supplied, bounties whose issue is closed upstream are reported as stale. */
  readonly issueState?: IssueStateClient;
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

export async function pollOnce(options: PollOptions): Promise<PollReport> {
  const { client, store, watchlist } = options;
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
      const html = await client.fetchBoard(entry);
      const bounties = parseBoard(html, entry.slug);
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

  const { live, closed } = options.issueState
    ? await filterLive(open, options.issueState)
    : { live: open, closed: [] as Bounty[] };

  const fresh = live.filter((bounty) => !previous.has(seenKey(bounty)));

  // Only prune boards we actually reached. Dropping ids for a board that failed
  // would re-announce its whole backlog as new on the next successful poll.
  const retained = [...previous].filter((key) => !polled.has(key.slice(0, key.indexOf("::"))));
  await store.save([...retained, ...open.map(seenKey)]);

  return {
    polledAt: now().toISOString(),
    fresh,
    open: live,
    stale: closed,
    errors,
  };
}
