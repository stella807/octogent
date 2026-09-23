import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeEntities, parseBoard } from "../src/parse.ts";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/coolify-bounties.html", import.meta.url)),
  "utf8",
);

describe("parseBoard", () => {
  const bounties = parseBoard(fixture, "coollabsio");

  it("separates open bounties from completed ones", () => {
    const open = bounties.filter((b) => b.status === "open");
    const completed = bounties.filter((b) => b.status === "completed");

    expect(open).toHaveLength(1);
    expect(completed.length).toBeGreaterThan(0);
  });

  it("reads the open bounty exactly as the board renders it", () => {
    const [open] = bounties.filter((b) => b.status === "open");

    expect(open).toMatchObject({
      org: "coollabsio",
      amountUsd: 20,
      title: "feat(oauth): add generic oidc provider",
      url: "https://github.com/coollabsio/coolify/pull/6696",
      status: "open",
    });
  });

  it("never reports a completed bounty as open", () => {
    const completedUrls = bounties.filter((b) => b.status === "completed").map((b) => b.url);
    const openUrls = bounties.filter((b) => b.status === "open").map((b) => b.url);

    expect(completedUrls).not.toHaveLength(0);
    for (const url of openUrls) expect(completedUrls).not.toContain(url);
  });

  it("decodes HTML entities in titles", () => {
    const titles = bounties.map((b) => b.title);
    expect(titles.some((t) => t.includes("Don't"))).toBe(true);
    expect(titles.every((t) => !t.includes("&#39;"))).toBe(true);
  });

  it("deduplicates the title and short-ref links that share one row", () => {
    const ids = bounties.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns nothing for a board with no bounty tables", () => {
    expect(parseBoard("<html><body>No open bounties</body></html>", "empty")).toEqual([]);
  });
});

describe("decodeEntities", () => {
  it("handles named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x27;d&#x27;")).toBe("a & b 'c' 'd'");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeEntities("&notreal;")).toBe("&notreal;");
  });
});
