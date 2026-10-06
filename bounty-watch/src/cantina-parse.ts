import type { Bounty } from "./domain/types.ts";

export const CANTINA_ORIGIN = "https://cantina.xyz";

const BOUNTY_URL_PATTERN = /^https:\/\/cantina\.xyz\/bounties\/([0-9a-f-]{36})$/;
const LOC_PATTERN = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
const FLIGHT_PATTERN = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g;
// Only array or object payloads can hold a program.
const ROW_PAYLOAD_PATTERN = /^[[{]/;
const COLON = 0x3a;
const COMMA = 0x2c;
const NEWLINE = 0x0a;
const TEXT_TAG = 0x54; // "T"

/** A Cantina bounty id is the UUID in its public URL, e.g. cantina.xyz/bounties/<uuid>. */
export function cantinaBountyId(url: string): string | undefined {
  return BOUNTY_URL_PATTERN.exec(url)?.[1];
}

/** Every <loc> in a sitemap or sitemap index, in document order. */
export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(LOC_PATTERN)].map((match) => decodeXml(match[1] ?? ""));
}

function decodeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

interface RawProgram {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: string;
  readonly kind: string;
  readonly totalRewardPot: string | number;
  readonly currencyCode?: unknown;
  readonly company?: { readonly name?: unknown; readonly handle?: unknown } | null;
}

function isProgram(value: unknown): value is RawProgram {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.url === "string" &&
    cantinaBountyId(v.url) === v.id &&
    typeof v.status === "string" &&
    typeof v.kind === "string" &&
    (typeof v.totalRewardPot === "string" || typeof v.totalRewardPot === "number")
  );
}

/**
 * Cantina is a Next.js app: the bounty data is not in the markup but in the React
 * Server Components payload, delivered as JS string literals passed to
 * `self.__next_f.push`. Those literals concatenate into a stream of `<hex id>:` rows.
 * Most rows end at a newline, but text rows (`<id>:T<hex byte length>,<text>`) carry
 * raw markdown and end after exactly that many UTF-8 bytes with no newline, so the
 * stream has to be walked by length rather than split on lines. Rows that are not
 * JSON (module refs, text) are skipped; the JSON ones hold the program objects.
 */
function flightRows(html: string): unknown[] {
  let stream = "";
  for (const match of html.matchAll(FLIGHT_PATTERN)) {
    try {
      stream += JSON.parse(match[1] ?? '""') as string;
    } catch {
      // A literal JSON cannot read is not a payload we can use.
    }
  }

  const bytes = Buffer.from(stream, "utf8");
  const rows: unknown[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const colon = bytes.indexOf(COLON, pos);
    if (colon === -1) break;

    if (bytes[colon + 1] === TEXT_TAG) {
      const comma = bytes.indexOf(COMMA, colon);
      const length = Number.parseInt(bytes.toString("latin1", colon + 2, comma), 16);
      if (comma === -1 || !Number.isFinite(length)) break;
      pos = comma + 1 + length;
      continue;
    }

    const newline = bytes.indexOf(NEWLINE, colon);
    const end = newline === -1 ? bytes.length : newline;
    const payload = bytes.toString("utf8", colon + 1, end);
    pos = end + 1;
    if (!ROW_PAYLOAD_PATTERN.test(payload)) continue;
    try {
      rows.push(JSON.parse(payload));
    } catch {
      // Not every bracketed row is JSON (e.g. module refs); those are not ours.
    }
  }
  return rows;
}

function collectPrograms(value: unknown, into: Map<string, RawProgram>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPrograms(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (isProgram(value) && !into.has(value.id)) into.set(value.id, value);
  for (const child of Object.values(value)) collectPrograms(child, into);
}

function toBounty(program: RawProgram): Bounty | undefined {
  const amountUsd = Number.parseFloat(String(program.totalRewardPot));
  if (!Number.isFinite(amountUsd)) return undefined;

  const currency = typeof program.currencyCode === "string" ? program.currencyCode : "";
  const companyName = typeof program.company?.name === "string" ? program.company.name.trim() : "";
  const handle = typeof program.company?.handle === "string" ? program.company.handle.trim() : "";
  const name = program.name.trim();

  return {
    id: program.url,
    source: "cantina",
    org: "cantina",
    // The pot is the program's maximum payout, not a single fixed reward.
    amountUsd,
    title:
      companyName && companyName.toLowerCase() !== name.toLowerCase()
        ? `${companyName} — ${name}`
        : name,
    url: program.url,
    ref: `cantina/${handle || program.id.slice(0, 8)}`,
    // Only "live" programs accept submissions; judging, paused and finished ones do not.
    status: program.status === "live" ? "open" : "completed",
    ...(currency && !/\bUSD/i.test(currency) ? { currency } : {}),
  };
}

/**
 * Parse every Cantina bounty program embedded in a rendered page. Works for both the
 * listing page and a single program's page, since both embed the same object shape.
 */
export function parseCantinaPage(html: string): Bounty[] {
  const programs = new Map<string, RawProgram>();
  for (const row of flightRows(html)) collectPrograms(row, programs);

  const bounties: Bounty[] = [];
  for (const program of programs.values()) {
    if (!program.kind.endsWith("bounty")) continue;
    const bounty = toBounty(program);
    if (bounty) bounties.push(bounty);
  }
  return bounties;
}
