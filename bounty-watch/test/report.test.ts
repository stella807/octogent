import { describe, expect, it } from "vitest";
import type { Bounty } from "../src/domain/types.ts";
import { formatReport } from "../src/report.ts";

const algora: Bounty = {
  id: "https://github.com/acme/x/issues/1",
  source: "algora",
  org: "acme",
  amountUsd: 300,
  title: "Fix the thing",
  url: "https://github.com/acme/x/issues/1",
  ref: "x#1",
  status: "open",
};
const cantina: Bounty = {
  id: "https://cantina.xyz/bounties/u",
  source: "cantina",
  org: "cantina",
  amountUsd: 2_000_000,
  title: "Acme — Core",
  url: "https://cantina.xyz/bounties/u",
  ref: "cantina/acme",
  status: "open",
};

describe("formatReport", () => {
  const report = (fresh: Bounty[], open: Bounty[] = fresh) => ({
    polledAt: "2026-10-06T00:00:00.000Z",
    fresh,
    open,
    errors: [],
  });

  it("labels a Cantina pot as a ceiling, not a reward", () => {
    expect(formatReport(report([cantina]))).toContain(
      "up to $2,000,000  cantina/acme  Acme — Core",
    );
  });

  it("shows a non-USD reward in its own currency", () => {
    expect(formatReport(report([{ ...cantina, amountUsd: 50_000, currency: "OP" }]))).toContain(
      "up to 50,000 OP",
    );
  });

  it("never adds Cantina pots into the Algora reward total", () => {
    const text = formatReport(report([], [algora, cantina]));
    expect(text).toContain("Open across watchlist: 1 bounty(s), $300 total.");
    expect(text).toContain("Live Cantina bug bounty programs: 1.");
  });
});
