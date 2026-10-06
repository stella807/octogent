import {
  CANTINA_ORIGIN,
  cantinaBountyId,
  parseCantinaPage,
  parseSitemapLocs,
} from "./cantina-parse.ts";
import { DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from "./client.ts";
import type { Bounty } from "./domain/types.ts";

/** Port: every Cantina bug bounty program currently discoverable, live or not. */
export interface CantinaClient {
  fetchBounties(): Promise<Bounty[]>;
}

export interface HttpCantinaClientOptions {
  readonly origin?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  /** Pause between page requests. Injectable so tests do not wait. */
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Refuse to crawl more program pages than this in one poll. */
  readonly maxProgramPages?: number;
}

const DEFAULT_DELAY_MS = 1_500;
const DEFAULT_MAX_PROGRAM_PAGES = 200;
const MAX_CHILD_SITEMAPS = 10;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cantina's /api/ is disallowed by its robots.txt, so this reads only pages crawlers
 * are allowed to fetch, combining two incomplete views:
 *
 * - the listing page embeds just the top ten programs by reward pot, but is current;
 * - the sitemap lists every program, but is regenerated only every few days.
 *
 * Programs the listing page did not cover are read from their own page, so a new
 * small program surfaces once the sitemap catches up, and a new large one at once.
 */
export class HttpCantinaClient implements CantinaClient {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #delayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxProgramPages: number;
  #requests = 0;

  constructor(options: HttpCantinaClientOptions = {}) {
    this.#origin = options.origin ?? CANTINA_ORIGIN;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#maxProgramPages = options.maxProgramPages ?? DEFAULT_MAX_PROGRAM_PAGES;
  }

  async fetchBounties(): Promise<Bounty[]> {
    this.#requests = 0;
    const found = new Map<string, Bounty>();
    const listing = await this.#get("/opportunities/bounties");
    for (const bounty of parseCantinaPage(listing.body)) found.set(bounty.id, bounty);

    const pending = (await this.#sitemapProgramUrls()).filter((url) => !found.has(url));
    if (pending.length > this.#maxProgramPages) {
      throw new Error(
        `Cantina sitemap lists ${pending.length} unread programs, over the ${this.#maxProgramPages} page cap`,
      );
    }

    for (const url of pending) {
      const page = await this.#get(new URL(url).pathname, { allowGone: true });
      // The sitemap lags, so it can still list a program that has since been removed.
      if (page.gone) continue;
      const bounty = parseCantinaPage(page.body).find((b) => b.id === url);
      if (bounty) found.set(bounty.id, bounty);
    }

    // Cantina always lists past programs alongside live ones, so finding none means
    // the page markup changed. Reporting zero would prune every seen id and then
    // re-announce the whole board once parsing is fixed.
    if (found.size === 0) {
      throw new Error("Cantina pages contained no bounty programs; the markup may have changed");
    }
    return [...found.values()];
  }

  async #sitemapProgramUrls(): Promise<string[]> {
    const index = parseSitemapLocs((await this.#get("/sitemap.xml")).body);
    // Only follow child sitemaps on Cantina's own origin; the index is not trusted
    // to point the poller anywhere else.
    const children = index
      .filter((loc) => this.#isOwnUrl(loc) && loc.endsWith(".xml"))
      .slice(0, MAX_CHILD_SITEMAPS);

    const locs = [...index];
    for (const child of children) {
      locs.push(...parseSitemapLocs((await this.#get(new URL(child).pathname)).body));
    }

    const urls = new Set<string>();
    for (const loc of locs) {
      const id = cantinaBountyId(loc);
      if (id) urls.add(`${CANTINA_ORIGIN}/bounties/${id}`);
    }
    return [...urls];
  }

  #isOwnUrl(value: string): boolean {
    try {
      return new URL(value).origin === new URL(CANTINA_ORIGIN).origin;
    } catch {
      return false;
    }
  }

  async #get(
    path: string,
    options: { allowGone?: boolean } = {},
  ): Promise<{ body: string; gone: boolean }> {
    if (this.#requests > 0) await this.#sleep(this.#delayMs);
    this.#requests += 1;

    const url = `${this.#origin}${path}`;
    const response = await fetch(url, {
      headers: { "user-agent": this.#userAgent, accept: "text/html,application/xml" },
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: "follow",
    });

    if (options.allowGone && (response.status === 404 || response.status === 410)) {
      return { body: "", gone: true };
    }
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return { body: await response.text(), gone: false };
  }
}
