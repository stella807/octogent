/**
 * Cantina's public API is the only reliable source for contest launches: its web pages
 * render client-side, and third-party trackers lag by weeks. Time-boxed contests are the
 * realistic earning path because the code is fresh and the pool is split among every
 * valid finding, unlike bug bounties on code that has already been audited repeatedly.
 */
export interface Contest {
  readonly name: string;
  readonly url: string;
  readonly status: string;
  readonly rewardPot: number;
  readonly currency: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly kycRequired: boolean;
}

export const CANTINA_COMPETITIONS_URL = "https://api.cantina.xyz/api/v0/competitions";

/** Keeps contests that have not finished: anything not marked complete whose end is still ahead. */
export function parseContests(raw: unknown, now: Date): Contest[] {
  if (!Array.isArray(raw)) return [];
  const contests: Contest[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const timeframe = (entry.timeframe ?? {}) as { start?: unknown; end?: unknown };
    const end = typeof timeframe.end === "string" ? timeframe.end : null;
    const status = typeof entry.status === "string" ? entry.status : "unknown";

    if (status === "complete") continue;
    if (end !== null && Date.parse(end) <= now.getTime()) continue;

    contests.push({
      name: typeof entry.name === "string" ? entry.name : "(unnamed)",
      url: typeof entry.url === "string" ? entry.url : "",
      status,
      rewardPot: Number(entry.totalRewardPot) || 0,
      currency: typeof entry.currencyCode === "string" ? entry.currencyCode : "",
      start: typeof timeframe.start === "string" ? timeframe.start : null,
      end,
      kycRequired: entry.kycRequired === true,
    });
  }

  return contests.sort((a, b) => b.rewardPot - a.rewardPot);
}

export async function fetchContests(now: Date = new Date()): Promise<Contest[]> {
  const response = await fetch(CANTINA_COMPETITIONS_URL, {
    headers: { accept: "application/json", "user-agent": "octogent-bounty-watch/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${CANTINA_COMPETITIONS_URL} returned HTTP ${response.status}`);
  return parseContests(await response.json(), now);
}

export function formatContests(contests: readonly Contest[]): string {
  if (contests.length === 0) return "No live or upcoming Cantina contests.";
  const lines = [`${contests.length} live or upcoming Cantina contest(s):`];
  for (const contest of contests) {
    const pot = `${contest.rewardPot.toLocaleString("en-US")} ${contest.currency}`.trim();
    const window =
      contest.start && contest.end
        ? `${contest.start.slice(0, 10)} -> ${contest.end.slice(0, 10)}`
        : "dates TBA";
    lines.push(
      `  ${contest.name}  [${contest.status}]  ${pot}  ${window}${contest.kycRequired ? "  KYC" : ""}`,
    );
    if (contest.url) lines.push(`    ${contest.url}`);
  }
  return lines.join("\n");
}
