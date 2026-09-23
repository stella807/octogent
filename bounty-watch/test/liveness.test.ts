import { describe, expect, it } from "vitest";
import type { Bounty } from "../src/domain/types.ts";
import type { GitHubRef, IssueState, IssueStateClient } from "../src/liveness.ts";
import { filterLive, parseGitHubRef } from "../src/liveness.ts";

const bounty = (url: string): Bounty => ({
  id: url,
  org: "acme",
  amountUsd: 100,
  title: "t",
  url,
  ref: "r",
  status: "open",
});

const clientFor = (states: Record<string, IssueState | Error>): IssueStateClient => ({
  async fetchState(ref: GitHubRef): Promise<IssueState> {
    const result = states[`${ref.owner}/${ref.repo}#${ref.number}`];
    if (result instanceof Error) throw result;
    return result ?? "unknown";
  },
});

describe("parseGitHubRef", () => {
  it("parses issue and pull URLs alike", () => {
    expect(parseGitHubRef("https://github.com/a/b/issues/7")).toEqual({
      owner: "a",
      repo: "b",
      number: 7,
    });
    expect(parseGitHubRef("https://github.com/a/b/pull/7")).toEqual({
      owner: "a",
      repo: "b",
      number: 7,
    });
  });

  it("rejects anything that is not a GitHub issue or PR URL", () => {
    expect(parseGitHubRef("https://example.com/a/b/issues/7")).toBeNull();
    expect(parseGitHubRef("https://github.com/a/b")).toBeNull();
  });
});

describe("filterLive", () => {
  it("drops bounties whose issue is closed upstream", async () => {
    const { live, stale } = await filterLive(
      [bounty("https://github.com/a/b/issues/1"), bounty("https://github.com/a/b/issues/2")],
      clientFor({ "a/b#1": "closed", "a/b#2": "open" }),
    ).then((r) => ({ live: r.live, stale: r.closed }));

    expect(live.map((b) => b.url)).toEqual(["https://github.com/a/b/issues/2"]);
    expect(stale.map((b) => b.url)).toEqual(["https://github.com/a/b/issues/1"]);
  });

  it("keeps a bounty when the state cannot be determined", async () => {
    const { live } = await filterLive(
      [bounty("https://github.com/a/b/issues/1")],
      clientFor({ "a/b#1": "unknown" }),
    );
    expect(live).toHaveLength(1);
  });

  it("keeps a bounty when the lookup throws, rather than hiding real work", async () => {
    const { live } = await filterLive(
      [bounty("https://github.com/a/b/issues/1")],
      clientFor({ "a/b#1": new Error("rate limited") }),
    );
    expect(live).toHaveLength(1);
  });

  it("keeps a bounty whose URL is not a GitHub ref", async () => {
    const { live } = await filterLive([bounty("https://example.com/whatever")], clientFor({}));
    expect(live).toHaveLength(1);
  });
});
