import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cantinaBountyId, parseCantinaPage, parseSitemapLocs } from "../src/cantina-parse.ts";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

/** Wrap RSC rows the way Next.js ships them: one JS string literal per push call. */
function flight(...chunks: string[]): string {
  return chunks
    .map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
    .join("");
}

const program = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-2222-3333-4444-555555555555",
  name: "Core",
  url: "https://cantina.xyz/bounties/11111111-2222-3333-4444-555555555555",
  company: { name: "Acme", handle: "acme" },
  status: "live",
  currencyCode: "USDC",
  totalRewardPot: "250000",
  kind: "public_bounty",
  ...overrides,
});

describe("parseCantinaPage", () => {
  it("reads a real program page exactly as Cantina embeds it", () => {
    const bounties = parseCantinaPage(fixture("cantina-program.html"));

    expect(bounties).toEqual([
      {
        id: "https://cantina.xyz/bounties/01da0370-eacb-48a2-a2df-3aa44f7bc838",
        source: "cantina",
        org: "cantina",
        amountUsd: 250_000,
        title: "Panoptic — panoptic-core",
        url: "https://cantina.xyz/bounties/01da0370-eacb-48a2-a2df-3aa44f7bc838",
        ref: "cantina/panoptic-labs",
        // The captured program was judging, not accepting submissions.
        status: "completed",
      },
    ]);
  });

  it("treats only live programs as open", () => {
    const pausedId = "aaaaaaaa-0000-0000-0000-000000000000";
    const paused = program({
      id: pausedId,
      url: `https://cantina.xyz/bounties/${pausedId}`,
      status: "paused",
    });
    const html = flight(`0:${JSON.stringify([program(), paused])}\n`);
    expect(parseCantinaPage(html).map((b) => b.status)).toEqual(["open", "completed"]);
  });

  it("walks past text rows that carry no trailing newline", () => {
    // The listing page embeds program terms as `<id>:T<hex bytes>,<markdown>`, and the
    // next row starts immediately after the text. Splitting on newlines would glue
    // that row onto the markdown and lose the program.
    const terms = "- Reporters release Acme from all claims. Ünïcode counts in bytes.";
    const html = flight(
      `21:T${Buffer.byteLength(terms).toString(16)},${terms}`,
      `7:${JSON.stringify([{ program: program({ instructions: "$21" }) }])}\n`,
    );

    expect(parseCantinaPage(html)).toHaveLength(1);
  });

  it("joins rows split across push calls", () => {
    const row = `4:${JSON.stringify({ items: [program()] })}\n`;
    const html = flight(row.slice(0, 40), row.slice(40));
    expect(parseCantinaPage(html)).toHaveLength(1);
  });

  it("reports each program once even when the page embeds it twice", () => {
    const html = flight(`1:${JSON.stringify([program()])}\n2:${JSON.stringify([program()])}\n`);
    expect(parseCantinaPage(html)).toHaveLength(1);
  });

  it("keeps a non-USD currency so the amount is not mistaken for dollars", () => {
    const [stable] = parseCantinaPage(
      flight(`1:${JSON.stringify(program({ currencyCode: "USDC + rEUL" }))}\n`),
    );
    const [token] = parseCantinaPage(
      flight(`1:${JSON.stringify(program({ currencyCode: "OP" }))}\n`),
    );

    expect(stable?.currency).toBeUndefined();
    expect(token?.currency).toBe("OP");
  });

  it("ignores objects whose id does not match their program URL", () => {
    const html = flight(
      `1:${JSON.stringify(program({ url: "https://evil.example/bounties/x" }))}\n`,
    );
    expect(parseCantinaPage(html)).toEqual([]);
  });

  it("returns nothing for a page with no flight data", () => {
    expect(parseCantinaPage("<html><body>maintenance</body></html>")).toEqual([]);
  });
});

describe("parseSitemapLocs", () => {
  it("finds the program URLs in Cantina's real sitemap", () => {
    const ids = parseSitemapLocs(fixture("cantina-sitemap.xml"))
      .map(cantinaBountyId)
      .filter((id) => id !== undefined);

    expect(ids).toHaveLength(44);
    expect(ids).toContain("01da0370-eacb-48a2-a2df-3aa44f7bc838");
  });
});

describe("cantinaBountyId", () => {
  it.each([
    [
      "https://cantina.xyz/bounties/01da0370-eacb-48a2-a2df-3aa44f7bc838",
      "01da0370-eacb-48a2-a2df-3aa44f7bc838",
    ],
    ["https://cantina.xyz/opportunities/bounties", undefined],
    ["https://cantina.xyz/bounties/01da0370-eacb-48a2-a2df-3aa44f7bc838/scope", undefined],
    ["https://evil.example/bounties/01da0370-eacb-48a2-a2df-3aa44f7bc838", undefined],
  ])("%s → %s", (url, expected) => {
    expect(cantinaBountyId(url)).toBe(expected);
  });
});
