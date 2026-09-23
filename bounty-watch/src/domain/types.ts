/**
 * Algora publishes no global bounty feed and no documented public JSON API, so the
 * only reachable source is the server-rendered org board at algora.io/<org>/bounties.
 * These types model what that page actually exposes — nothing more.
 */

export type BountyStatus = "open" | "completed";

export interface Bounty {
  /** Stable identity across polls: the GitHub issue/PR URL the bounty is attached to. */
  readonly id: string;
  readonly org: string;
  readonly amountUsd: number;
  readonly title: string;
  readonly url: string;
  /** Short human reference as Algora renders it, e.g. "coolify#7941". */
  readonly ref: string;
  readonly status: BountyStatus;
}

export interface WatchEntry {
  /** Algora org slug, e.g. "coollabsio". */
  readonly slug: string;
  /** Board path relative to the org, for orgs that split community boards out. */
  readonly path?: string;
}

export interface Watchlist {
  readonly entries: readonly WatchEntry[];
  /** Bounties below this are not worth the setup cost; see README. */
  readonly minAmountUsd: number;
}

/** Result of one poll cycle, diffed against previously seen state. */
export interface PollReport {
  readonly polledAt: string;
  readonly fresh: readonly Bounty[];
  readonly open: readonly Bounty[];
  /** Listed as open by Algora but whose issue or PR is confirmed closed upstream. */
  readonly stale: readonly Bounty[];
  readonly errors: readonly PollError[];
}

export interface PollError {
  readonly slug: string;
  readonly message: string;
}
