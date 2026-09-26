import { describe, expect, it } from "vitest";

import { createSwarmQueueStore } from "../src/deck/swarmQueue";

const items = (...indices: number[]) =>
  indices.map((todoIndex) => ({ todoIndex, todoText: `item ${todoIndex}` }));

describe("swarm queue", () => {
  it("hands out overflow items in todo order, one claim at a time", () => {
    const store = createSwarmQueueStore();
    store.open("docs", ["docs-swarm-0", "docs-swarm-1"], items(2, 3, 4));

    expect(store.claim("docs", "docs-swarm-1")).toEqual({
      ok: true,
      item: { todoIndex: 2, todoText: "item 2" },
      remaining: 2,
    });
    expect(store.claim("docs", "docs-swarm-0")).toMatchObject({
      ok: true,
      item: { todoIndex: 3 },
      remaining: 1,
    });
    expect(store.claim("docs", "docs-swarm-0")).toMatchObject({ item: { todoIndex: 4 } });
    expect(store.claim("docs", "docs-swarm-1")).toEqual({ ok: true, item: null, remaining: 0 });
  });

  it("records who claimed what so the coordinator can see it", () => {
    const store = createSwarmQueueStore();
    store.open("docs", ["docs-swarm-0"], items(9));
    store.claim("docs", "docs-swarm-0");

    expect(store.snapshot("docs")).toEqual({
      workerTerminalIds: ["docs-swarm-0"],
      pending: [],
      claimed: [
        expect.objectContaining({ todoIndex: 9, todoText: "item 9", terminalId: "docs-swarm-0" }),
      ],
    });
  });

  it("refuses claims from terminals outside the swarm's worker pool", () => {
    const store = createSwarmQueueStore();
    store.open("docs", ["docs-swarm-0"], items(1));

    expect(store.claim("docs", "docs-swarm-parent")).toEqual({ ok: false, error: "not-a-worker" });
    expect(store.claim("other", "docs-swarm-0")).toEqual({ ok: false, error: "no-swarm" });
    expect(store.snapshot("docs")?.pending).toHaveLength(1);
  });

  it("replaces a previous swarm's queue when a new swarm opens", () => {
    const store = createSwarmQueueStore();
    store.open("docs", ["docs-swarm-0"], items(1, 2));
    store.open("docs", ["docs-swarm-5"], items(7));

    expect(store.claim("docs", "docs-swarm-0")).toEqual({ ok: false, error: "not-a-worker" });
    expect(store.claim("docs", "docs-swarm-5")).toMatchObject({ item: { todoIndex: 7 } });
  });
});
