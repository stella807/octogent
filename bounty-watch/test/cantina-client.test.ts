import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpCantinaClient } from "../src/cantina-client.ts";

const ORIGIN = "https://cantina.test";
const uuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const programUrl = (n: number): string => `https://cantina.xyz/bounties/${uuid(n)}`;

function page(...ns: number[]): string {
  const programs = ns.map((n) => ({
    id: uuid(n),
    name: `Program ${n}`,
    url: programUrl(n),
    company: { name: `Co ${n}`, handle: `co${n}` },
    status: "live",
    currencyCode: "USDC",
    totalRewardPot: String(n * 1000),
    kind: "public_bounty",
  }));
  const row = `0:${JSON.stringify(programs)}\n`;
  return `<script>self.__next_f.push([1,${JSON.stringify(row)}])</script>`;
}

const sitemap = (locs: string[]): string =>
  `<urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
const sitemapIndex = (locs: string[]): string =>
  `<sitemapindex>${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("")}</sitemapindex>`;

/** Route fetch to canned responses keyed by path, recording what was requested. */
function stubSite(routes: Record<string, string | number>): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    expect(url.origin).toBe(ORIGIN);
    requested.push(url.pathname);
    const route = routes[url.pathname];
    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "number") return new Response("err", { status: route });
    return new Response(route, { status: 200 });
  });
  return requested;
}

const client = (sleep: (ms: number) => Promise<void> = async () => {}) =>
  new HttpCantinaClient({ origin: ORIGIN, sleep });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpCantinaClient", () => {
  it("reads only programs the listing page did not already cover", async () => {
    const requested = stubSite({
      "/opportunities/bounties": page(1, 2),
      "/sitemap.xml": sitemapIndex(["https://cantina.xyz/sitemap-0.xml"]),
      "/sitemap-0.xml": sitemap([programUrl(1), programUrl(3), "https://cantina.xyz/about"]),
      [`/bounties/${uuid(3)}`]: page(3),
    });

    const bounties = await client().fetchBounties();

    expect(bounties.map((b) => b.title).sort()).toEqual([
      "Co 1 — Program 1",
      "Co 2 — Program 2",
      "Co 3 — Program 3",
    ]);
    expect(requested).toEqual([
      "/opportunities/bounties",
      "/sitemap.xml",
      "/sitemap-0.xml",
      `/bounties/${uuid(3)}`,
    ]);
  });

  it("never requests the robots-disallowed API", async () => {
    const requested = stubSite({
      "/opportunities/bounties": page(1),
      "/sitemap.xml": sitemap([programUrl(2)]),
      [`/bounties/${uuid(2)}`]: page(2),
    });

    await client().fetchBounties();

    expect(requested.some((path) => path.startsWith("/api/"))).toBe(false);
  });

  it("pauses between every request after the first", async () => {
    stubSite({
      "/opportunities/bounties": page(1),
      "/sitemap.xml": sitemap([programUrl(2), programUrl(3)]),
      [`/bounties/${uuid(2)}`]: page(2),
      [`/bounties/${uuid(3)}`]: page(3),
    });
    const delays: number[] = [];

    await client(async (ms) => {
      delays.push(ms);
    }).fetchBounties();

    expect(delays).toEqual([1500, 1500, 1500]);
  });

  it("skips a program the stale sitemap lists but Cantina has removed", async () => {
    stubSite({
      "/opportunities/bounties": page(1),
      "/sitemap.xml": sitemap([programUrl(9)]),
    });

    const bounties = await client().fetchBounties();
    expect(bounties.map((b) => b.id)).toEqual([programUrl(1)]);
  });

  it("fails the whole board on a server error so seen state is retained", async () => {
    stubSite({
      "/opportunities/bounties": page(1),
      "/sitemap.xml": sitemap([programUrl(2)]),
      [`/bounties/${uuid(2)}`]: 503,
    });

    await expect(client().fetchBounties()).rejects.toThrow(/HTTP 503/);
  });

  it("fails rather than reporting an empty board when the markup changes", async () => {
    stubSite({
      "/opportunities/bounties": "<html>redesigned</html>",
      "/sitemap.xml": sitemap([programUrl(2)]),
      [`/bounties/${uuid(2)}`]: "<html>redesigned</html>",
    });

    await expect(client().fetchBounties()).rejects.toThrow(/markup may have changed/);
  });

  it("does not follow a sitemap index entry to another host", async () => {
    const requested = stubSite({
      "/opportunities/bounties": page(1),
      "/sitemap.xml": sitemapIndex(["https://evil.example/sitemap.xml"]),
    });

    await client().fetchBounties();
    expect(requested).toEqual(["/opportunities/bounties", "/sitemap.xml"]);
  });

  it("refuses to crawl an implausibly large sitemap", async () => {
    stubSite({
      "/opportunities/bounties": page(1),
      "/sitemap.xml": sitemap([programUrl(2), programUrl(3), programUrl(4)]),
    });

    await expect(
      new HttpCantinaClient({
        origin: ORIGIN,
        sleep: async () => {},
        maxProgramPages: 2,
      }).fetchBounties(),
    ).rejects.toThrow(/page cap/);
  });
});
