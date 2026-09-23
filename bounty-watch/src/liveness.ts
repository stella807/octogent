import type { Bounty } from "./domain/types.ts";

/**
 * Algora keeps listing a bounty after its issue or PR is closed — an orphaned bounty
 * cannot be deleted by its sponsor. Two of the three "open" bounties found on the
 * first real run were already resolved upstream, so board status alone is not enough
 * to decide whether work exists.
 */
export type IssueState = "open" | "closed" | "unknown";

export interface GitHubRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface IssueStateClient {
  fetchState(ref: GitHubRef): Promise<IssueState>;
}

const REF_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;

export function parseGitHubRef(url: string): GitHubRef | null {
  const match = REF_PATTERN.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const number = Number.parseInt(match[3], 10);
  return Number.isSafeInteger(number) ? { owner: match[1], repo: match[2], number } : null;
}

export class HttpIssueStateClient implements IssueStateClient {
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #token: string | undefined;

  constructor(options: { timeoutMs?: number; userAgent?: string; token?: string } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#userAgent = options.userAgent ?? "octogent-bounty-watch/0.1";
    // A token lifts the anonymous 60/hour limit and is required in sandboxes whose
    // egress proxy rejects unauthenticated GitHub API calls.
    this.#token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  }

  async fetchState(ref: GitHubRef): Promise<IssueState> {
    // The issues endpoint serves pull requests too, so one call covers both URL forms.
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": this.#userAgent,
        accept: "application/vnd.github+json",
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    // Unauthenticated callers get 60 requests/hour. A 403 or 404 tells us nothing about
    // the bounty, so report unknown and let the caller keep it.
    if (!response.ok) return "unknown";

    const body = (await response.json()) as { state?: unknown };
    return body.state === "closed" ? "closed" : body.state === "open" ? "open" : "unknown";
  }
}

/**
 * Drops bounties whose issue is confirmed closed. Anything we cannot verify is kept:
 * hiding a real bounty is a worse failure than showing a stale one.
 */
export async function filterLive(
  bounties: readonly Bounty[],
  client: IssueStateClient,
): Promise<{ live: Bounty[]; closed: Bounty[] }> {
  const live: Bounty[] = [];
  const closed: Bounty[] = [];

  for (const bounty of bounties) {
    const ref = parseGitHubRef(bounty.url);
    if (!ref) {
      live.push(bounty);
      continue;
    }
    let state: IssueState;
    try {
      state = await client.fetchState(ref);
    } catch {
      state = "unknown";
    }
    (state === "closed" ? closed : live).push(bounty);
  }

  return { live, closed };
}
