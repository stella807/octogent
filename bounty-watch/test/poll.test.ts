import { describe, expect, it } from "vitest";
import type { BoardClient } from "../src/client.ts";
import type { WatchEntry, Watchlist } from "../src/domain/types.ts";
import { pollOnce, seenKey } from "../src/poll.ts";
import { MemorySeenStore } from "../src/store.ts";

function board(
  rows: Array<{ amount: number; url: string; title: string }>,
  completed: string[] = [],
): string {
  const row = (amount: number, url: string, title: string) =>
    `<tr><td><div><div>$${amount}</div><a href="${url}">${title}</a><a href="${url}">ref</a></div></td></tr>`;
  return [
    "<h2>Open Bounties</h2><table>",
    ...rows.map((r) => row(r.amount, r.url, r.title)),
    "</table><h2>Completed Bounties</h2><table>",
    ...completed.map((url) => row(999, url, "done")),
    "</table>",
  ].join("");
}

function clientFor(boards: Record<string, string | Error>): BoardClient {
  return {
    async fetchBoard(entry: WatchEntry): Promise<string> {
      const result = boards[entry.slug];
      if (result === undefined) throw new Error(`no stub for ${entry.slug}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const watchlist = (entries: WatchEntry[], minAmountUsd = 0): Watchlist => ({
  entries,
  minAmountUsd,
});
const noSleep = async () => {};

describe("pollOnce", () => {
  it("reports every open bounty as fresh on a cold start", async () => {
    const report = await pollOnce({
      client: clientFor({
        acme: board([{ amount: 100, url: "https://github.com/acme/x/issues/1", title: "one" }]),
      }),
      store: new MemorySeenStore(),
      watchlist: watchlist([{ slug: "acme" }]),
      sleep: noSleep,
    });

    expect(report.fresh).toHaveLength(1);
    expect(report.fresh[0]?.title).toBe("one");
  });

  it("reports nothing fresh when the board has not changed", async () => {
    const client = clientFor({
      acme: board([{ amount: 100, url: "https://github.com/acme/x/issues/1", title: "one" }]),
    });
    const store = new MemorySeenStore();
    const list = watchlist([{ slug: "acme" }]);

    await pollOnce({ client, store, watchlist: list, sleep: noSleep });
    const second = await pollOnce({ client, store, watchlist: list, sleep: noSleep });

    expect(second.fresh).toHaveLength(0);
    expect(second.open).toHaveLength(1);
  });

  it("surfaces only the newly added bounty on a later poll", async () => {
    const store = new MemorySeenStore();
    const list = watchlist([{ slug: "acme" }]);

    await pollOnce({
      client: clientFor({
        acme: board([{ amount: 100, url: "https://github.com/acme/x/issues/1", title: "one" }]),
      }),
      store,
      watchlist: list,
      sleep: noSleep,
    });

    const second = await pollOnce({
      client: clientFor({
        acme: board([
          { amount: 100, url: "https://github.com/acme/x/issues/1", title: "one" },
          { amount: 250, url: "https://github.com/acme/x/issues/2", title: "two" },
        ]),
      }),
      store,
      watchlist: list,
      sleep: noSleep,
    });

    expect(second.fresh.map((b) => b.title)).toEqual(["two"]);
  });

  it("drops bounties below the watchlist floor", async () => {
    const report = await pollOnce({
      client: clientFor({
        acme: board([
          { amount: 20, url: "https://github.com/acme/x/issues/1", title: "too small" },
          { amount: 500, url: "https://github.com/acme/x/issues/2", title: "worth it" },
        ]),
      }),
      store: new MemorySeenStore(),
      watchlist: watchlist([{ slug: "acme" }], 50),
      sleep: noSleep,
    });

    expect(report.open.map((b) => b.title)).toEqual(["worth it"]);
  });

  it("never reports completed bounties", async () => {
    const report = await pollOnce({
      client: clientFor({ acme: board([], ["https://github.com/acme/x/issues/9"]) }),
      store: new MemorySeenStore(),
      watchlist: watchlist([{ slug: "acme" }]),
      sleep: noSleep,
    });

    expect(report.open).toHaveLength(0);
    expect(report.fresh).toHaveLength(0);
  });

  it("keeps polling other boards when one fails, and records the error", async () => {
    const report = await pollOnce({
      client: clientFor({
        broken: new Error("HTTP 503"),
        acme: board([{ amount: 100, url: "https://github.com/acme/x/issues/1", title: "one" }]),
      }),
      store: new MemorySeenStore(),
      watchlist: watchlist([{ slug: "broken" }, { slug: "acme" }]),
      sleep: noSleep,
    });

    expect(report.errors).toEqual([{ slug: "broken", message: "HTTP 503" }]);
    expect(report.open).toHaveLength(1);
  });

  it("does not re-announce a failed board's bounties once it recovers", async () => {
    const store = new MemorySeenStore();
    const list = watchlist([{ slug: "acme" }]);
    const healthy = board([
      { amount: 100, url: "https://github.com/acme/x/issues/1", title: "one" },
    ]);

    await pollOnce({
      client: clientFor({ acme: healthy }),
      store,
      watchlist: list,
      sleep: noSleep,
    });
    await pollOnce({
      client: clientFor({ acme: new Error("HTTP 503") }),
      store,
      watchlist: list,
      sleep: noSleep,
    });
    const recovered = await pollOnce({
      client: clientFor({ acme: healthy }),
      store,
      watchlist: list,
      sleep: noSleep,
    });

    expect(recovered.fresh).toHaveLength(0);
  });

  it("pauses between boards so the poller stays polite", async () => {
    const delays: number[] = [];
    await pollOnce({
      client: clientFor({ a: board([]), b: board([]), c: board([]) }),
      store: new MemorySeenStore(),
      watchlist: watchlist([{ slug: "a" }, { slug: "b" }, { slug: "c" }]),
      sleep: async (ms) => {
        delays.push(ms);
      },
      delayMs: 1500,
    });

    // One pause between each pair of boards, never before the first request.
    expect(delays).toEqual([1500, 1500]);
  });

  it("reports a bounty as stale when its issue is closed upstream", async () => {
    const report = await pollOnce({
      client: clientFor({
        acme: board([
          { amount: 100, url: "https://github.com/acme/x/issues/1", title: "dead" },
          { amount: 100, url: "https://github.com/acme/x/issues/2", title: "alive" },
        ]),
      }),
      store: new MemorySeenStore(),
      watchlist: watchlist([{ slug: "acme" }]),
      sleep: noSleep,
      issueState: {
        async fetchState(ref) {
          return ref.number === 1 ? "closed" : "open";
        },
      },
    });

    expect(report.open.map((b) => b.title)).toEqual(["alive"]);
    expect(report.stale.map((b) => b.title)).toEqual(["dead"]);
    expect(report.fresh.map((b) => b.title)).toEqual(["alive"]);
  });

  it("scopes identity per board so the same issue on two boards is tracked separately", () => {
    const base = {
      id: "https://github.com/acme/x/issues/1",
      amountUsd: 10,
      title: "t",
      url: "u",
      ref: "r",
      status: "open",
    } as const;
    expect(seenKey({ ...base, org: "one" })).not.toBe(seenKey({ ...base, org: "two" }));
  });
});
