import { describe, expect, it } from "vitest";
import { formatContests, parseContests } from "../src/cantina.ts";

const now = new Date("2026-09-23T12:00:00Z");
const contest = (overrides: Record<string, unknown>) => ({
  name: "Example",
  url: "https://cantina.xyz/competitions/x",
  status: "live",
  totalRewardPot: "50000",
  currencyCode: "USDC",
  kycRequired: false,
  timeframe: { start: "2026-09-20T00:00:00Z", end: "2026-10-01T00:00:00Z" },
  ...overrides,
});

describe("parseContests", () => {
  it("keeps live and upcoming contests", () => {
    const parsed = parseContests(
      [contest({ status: "live" }), contest({ name: "Soon", status: "upcoming" })],
      now,
    );
    expect(parsed.map((c) => c.name)).toEqual(["Example", "Soon"]);
  });

  it("drops completed contests", () => {
    expect(parseContests([contest({ status: "complete" })], now)).toEqual([]);
  });

  it("drops contests whose window has already ended, whatever their status says", () => {
    expect(
      parseContests(
        [contest({ timeframe: { start: "2026-08-01T00:00:00Z", end: "2026-08-10T00:00:00Z" } })],
        now,
      ),
    ).toEqual([]);
  });

  it("sorts by prize pool and reads the pot as a number", () => {
    const parsed = parseContests(
      [
        contest({ name: "Small", totalRewardPot: "30000" }),
        contest({ name: "Big", totalRewardPot: "400000" }),
      ],
      now,
    );
    expect(parsed.map((c) => c.name)).toEqual(["Big", "Small"]);
    expect(parsed[0]?.rewardPot).toBe(400000);
  });

  it("tolerates malformed payloads", () => {
    expect(parseContests({ not: "an array" }, now)).toEqual([]);
    expect(parseContests([null, 7, "x"], now)).toEqual([]);
  });
});

describe("formatContests", () => {
  it("says so plainly when nothing is open", () => {
    expect(formatContests([])).toBe("No live or upcoming Cantina contests.");
  });
});
