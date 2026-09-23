import type { Bounty, BountyStatus } from "./domain/types.ts";

const OPEN_HEADING = "Open Bounties";
const COMPLETED_HEADING = "Completed Bounties";

const ROW_PATTERN = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const AMOUNT_PATTERN = /\$\s*([0-9][0-9,]*)/;
const LINK_PATTERN =
  /<a\s+href="(https:\/\/github\.com\/[^"]+?\/(?:issues|pull)\/\d+)"[^>]*>([\s\S]*?)<\/a>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The board renders both tables with identical row markup, so status can only be
 * derived from which heading the row falls under. Slicing by heading offset is the
 * one signal the page gives us; a row outside both sections is deliberately dropped
 * rather than guessed at.
 */
function sectionBounds(html: string): { open: string; completed: string } {
  const completedAt = html.indexOf(COMPLETED_HEADING);
  // Skip the stat-card occurrence of the heading by anchoring on the one that a
  // table actually follows.
  let openAt = -1;
  for (
    let cursor = html.indexOf(OPEN_HEADING);
    cursor !== -1;
    cursor = html.indexOf(OPEN_HEADING, cursor + 1)
  ) {
    const table = html.indexOf("<table", cursor);
    if (table !== -1 && (completedAt === -1 || table < completedAt)) {
      openAt = cursor;
      break;
    }
  }
  const open =
    openAt === -1 ? "" : html.slice(openAt, completedAt === -1 ? undefined : completedAt);
  const completed = completedAt === -1 ? "" : html.slice(completedAt);
  return { open, completed };
}

function parseSection(section: string, org: string, status: BountyStatus): Bounty[] {
  const bounties: Bounty[] = [];
  const seen = new Set<string>();

  for (const rowMatch of section.matchAll(ROW_PATTERN)) {
    const row = rowMatch[1] ?? "";
    const amountMatch = AMOUNT_PATTERN.exec(row);
    if (!amountMatch?.[1]) continue;

    const amountUsd = Number.parseInt(amountMatch[1].replaceAll(",", ""), 10);
    if (!Number.isFinite(amountUsd)) continue;

    // A row carries the same href twice: once on the title, once on the short ref.
    const links = [...row.matchAll(LINK_PATTERN)];
    const first = links[0];
    if (!first?.[1]) continue;

    const url = first[1];
    if (seen.has(url)) continue;
    seen.add(url);

    const title = stripTags(first[2] ?? "");
    const ref = stripTags(links[1]?.[2] ?? "") || url.split("/").slice(-3).join("/");

    bounties.push({ id: url, org, amountUsd, title, url, ref, status });
  }

  return bounties;
}

/** Parse one rendered Algora org board into its open and completed bounties. */
export function parseBoard(html: string, org: string): Bounty[] {
  const { open, completed } = sectionBounds(html);
  return [...parseSection(open, org, "open"), ...parseSection(completed, org, "completed")];
}
