import { describe, expect, it } from "vitest";

import {
  SWARM_AUTO_MODEL,
  SWARM_AUTO_TIER_MODELS,
  classifyTodoComplexity,
  resolveSwarmWorkerModel,
} from "../src/application/swarmModelRouting";

describe("classifyTodoComplexity", () => {
  it.each([
    "Fix typo in README",
    "Rename getUser to fetchUser",
    "Update the changelog for 0.2.0",
    "Add doc comments to the parser",
    "Bump vitest version",
    "Run the formatter over apps/web",
    "Update the README install steps",
    "Clarify the docs for the --resume flag",
  ])("treats small mechanical work as simple: %s", (text) => {
    expect(classifyTodoComplexity(text).tier).toBe("simple");
  });

  it.each([
    "Refactor the session runtime into smaller modules",
    "Investigate flaky websocket reconnect test",
    "Fix auth token refresh race",
    "Migrate the registry to a new schema",
    // Mentions a simple word, but the work itself is not mechanical.
    "Rename the auth module and migrate every caller",
    // Where the work happens (docs) says nothing about how hard it is.
    "Add search to the docs site",
    "Implement dark mode for the README preview",
  ])("keeps anything risky on the standard model: %s", (text) => {
    expect(classifyTodoComplexity(text).tier).toBe("standard");
  });

  it("defaults unfamiliar work to standard rather than guessing cheap", () => {
    expect(classifyTodoComplexity("Add CSV export to the usage view")).toEqual({
      tier: "standard",
      reason: "default",
    });
  });

  it("does not trust a simple keyword in a long, involved item", () => {
    const text =
      "Rename the settings panel and also rebuild how preferences load, persist, sync across tabs, and recover from corrupt files";
    expect(classifyTodoComplexity(text).tier).toBe("standard");
  });

  it("lets explicit #simple and #complex tags override the heuristic", () => {
    expect(classifyTodoComplexity("Add CSV export #simple")).toEqual({
      tier: "simple",
      reason: "tagged #simple",
    });
    expect(classifyTodoComplexity("Fix typo in the sync engine #complex")).toEqual({
      tier: "standard",
      reason: "tagged #complex",
    });
  });

  it("explains which word decided it", () => {
    expect(classifyTodoComplexity("Fix typo in README").reason).toBe('mentions "typo"');
  });
});

describe("resolveSwarmWorkerModel", () => {
  it("maps auto to a cheap model for simple items and a stronger one otherwise", () => {
    expect(resolveSwarmWorkerModel(SWARM_AUTO_MODEL, "Fix typo in README")).toBe(
      SWARM_AUTO_TIER_MODELS.simple,
    );
    expect(resolveSwarmWorkerModel(SWARM_AUTO_MODEL, "Refactor the runtime")).toBe(
      SWARM_AUTO_TIER_MODELS.standard,
    );
  });

  it("passes explicit models and no model through unchanged", () => {
    expect(resolveSwarmWorkerModel("opus", "Fix typo")).toBe("opus");
    expect(resolveSwarmWorkerModel(undefined, "Fix typo")).toBeUndefined();
  });
});
