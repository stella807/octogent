/**
 * Neither source offers a feed we may poll: Algora has no global feed or public API,
 * and Cantina's JSON API is disallowed by its robots.txt. Both are read from the pages
 * they publicly render, and these types model what those pages expose — nothing more.
 */

/** Which site a watchlist entry polls. */
export type BountySource = "algora" | "cantina";

export type BountyStatus = "open" | "completed";

export interface Bounty {
  /**
   * Stable identity across polls: the GitHub issue/PR URL for an Algora bounty, the
   * program URL for a Cantina bug bounty.
   */
  readonly id: string;
  readonly source: BountySource;
  readonly org: string;
  /** Algora: the bounty reward. Cantina: the program's maximum payout pot. */
  readonly amountUsd: number;
  /** Set only when the reward is not paid in USD or a USD stablecoin. */
  readonly currency?: string;
  readonly title: string;
  readonly url: string;
  /** Short human reference, e.g. "coolify#7941" or "cantina/uniswap". */
  readonly ref: string;
  readonly status: BountyStatus;
}

export interface WatchEntry {
  /** Defaults to Algora. */
  readonly source?: BountySource;
  /** Algora org slug, e.g. "coollabsio"; for Cantina, the label the board is tracked under. */
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
  readonly errors: readonly PollError[];
}

export interface PollError {
  readonly slug: string;
  readonly message: string;
}
