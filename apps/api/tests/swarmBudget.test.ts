import { describe, expect, it, vi } from "vitest";

import { createSwarmBudgetStore } from "../src/deck/swarmBudget";

const setup = (budgetTokens = 1000, maxAttempts = 1) => {
  const onExceeded = vi.fn();
  const store = createSwarmBudgetStore({ onExceeded });
  store.open("docs", { budgetTokens, maxAttempts });
  store.startAttempt("docs", ["docs-swarm-parent", "docs-swarm-0", "docs-swarm-1"]);
  return { store, onExceeded };
};

describe("swarm budget", () => {
  it("adds every agent's usage into one shared total", () => {
    const { store, onExceeded } = setup();
    store.recordUsage("docs-swarm-parent", 300);
    store.recordUsage("docs-swarm-0", 200);
    store.recordUsage("docs-swarm-0", 250); // totals are absolute, not deltas

    expect(store.snapshot("docs")?.attempts[0]).toMatchObject({
      spentTokens: 550,
      tokensByTerminal: { "docs-swarm-parent": 300, "docs-swarm-0": 250 },
      status: "running",
    });
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("fires exactly once when the shared total reaches the budget", () => {
    const { store, onExceeded } = setup(1000);
    store.recordUsage("docs-swarm-0", 600);
    store.recordUsage("docs-swarm-1", 400);
    store.recordUsage("docs-swarm-1", 900);

    expect(onExceeded).toHaveBeenCalledTimes(1);
    expect(onExceeded).toHaveBeenCalledWith("docs", 1);
    expect(store.snapshot("docs")?.attempts[0]?.status).toBe("exceeded");
  });

  it("ignores usage from terminals that are not in a budgeted swarm", () => {
    const { store, onExceeded } = setup(10);
    store.recordUsage("someone-else", 1_000_000);
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("starts each retry with a fresh budget and new agents, keeping the history", () => {
    const { store, onExceeded } = setup(100, 2);
    store.recordUsage("docs-swarm-0", 150);
    expect(store.canRetry("docs")).toBe(true);

    store.startAttempt("docs", ["docs-swarm-a2-parent", "docs-swarm-a2-0"]);
    // Late usage from a stopped first-attempt agent must not count against the retry.
    store.recordUsage("docs-swarm-0", 400);
    store.recordUsage("docs-swarm-a2-0", 50);

    const snapshot = store.snapshot("docs");
    expect(snapshot?.attempts.map((a) => [a.attempt, a.spentTokens, a.status])).toEqual([
      [1, 400, "exceeded"],
      [2, 50, "running"],
    ]);
    expect(snapshot?.totalSpentTokens).toBe(450);
    expect(store.canRetry("docs")).toBe(false);
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it("records the final outcome for the operator", () => {
    const { store } = setup();
    store.setOutcome("docs", "exhausted");
    expect(store.snapshot("docs")?.outcome).toBe("exhausted");
  });

  it("forgets a closed budget so a later unbudgeted swarm with the same ids is left alone", () => {
    const { store, onExceeded } = setup(10);
    expect(store.tracks("docs-swarm-0")).toBe(true);
    store.close("docs");
    store.recordUsage("docs-swarm-0", 1_000);

    expect(store.tracks("docs-swarm-0")).toBe(false);
    expect(store.snapshot("docs")).toBeNull();
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("warns once at 80% of the budget, before the hard stop", () => {
    const onExceeded = vi.fn();
    const onWarning = vi.fn();
    const store = createSwarmBudgetStore({ onExceeded, onWarning });
    store.open("docs", { budgetTokens: 1000, maxAttempts: 1 });
    store.startAttempt("docs", ["docs-swarm-0"]);

    store.recordUsage("docs-swarm-0", 799);
    expect(onWarning).not.toHaveBeenCalled();
    store.recordUsage("docs-swarm-0", 800);
    store.recordUsage("docs-swarm-0", 900);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith("docs", 1);
    expect(store.snapshot("docs")?.attempts[0]?.warned).toBe(true);
    expect(onExceeded).not.toHaveBeenCalled();
  });
});
