import { describe, expect, it } from "vitest";
import { WatchlistError, parseWatchlist } from "../src/watchlist.ts";

describe("parseWatchlist", () => {
  it("accepts bare slugs and objects", () => {
    const list = parseWatchlist({ entries: ["acme", { slug: "beta", path: "bounties" }] });
    expect(list.entries).toEqual([{ slug: "acme" }, { slug: "beta", path: "bounties" }]);
  });

  it("defaults the reward floor when unset", () => {
    expect(parseWatchlist({ entries: ["acme"] }).minAmountUsd).toBe(50);
  });

  it("honours an explicit floor, including zero", () => {
    expect(parseWatchlist({ entries: ["acme"], minAmountUsd: 0 }).minAmountUsd).toBe(0);
  });

  it.each([
    ["not an object", "nope"],
    ["missing entries", {}],
    ["empty entries", { entries: [] }],
    ["blank slug", { entries: [{ slug: "  " }] }],
    ["slug of wrong type", { entries: [{ slug: 7 }] }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseWatchlist(input)).toThrow(WatchlistError);
  });
});
