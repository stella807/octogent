import type { WatchEntry } from "./domain/types.ts";

/** Port: everything the poller needs from the network, so tests can supply their own. */
export interface BoardClient {
  fetchBoard(entry: WatchEntry): Promise<string>;
}

export interface HttpBoardClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

const DEFAULT_BASE_URL = "https://algora.io";
const DEFAULT_TIMEOUT_MS = 20_000;
// Identifies the poller so Algora can throttle or contact us rather than silently block.
const DEFAULT_USER_AGENT = "octogent-bounty-watch/0.1 (+https://github.com/stella807/octogent)";

export function boardUrl(entry: WatchEntry, baseUrl: string = DEFAULT_BASE_URL): string {
  // Plain /<org>/bounties renders no bounty tables; the community board is the
  // only path that serves them.
  const path = entry.path ?? "bounties/community";
  return `${baseUrl}/${entry.slug}/${path}`;
}

export class HttpBoardClient implements BoardClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  constructor(options: HttpBoardClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async fetchBoard(entry: WatchEntry): Promise<string> {
    const url = boardUrl(entry, this.#baseUrl);
    const response = await fetch(url, {
      headers: { "user-agent": this.#userAgent, accept: "text/html" },
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return await response.text();
  }
}
