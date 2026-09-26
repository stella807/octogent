import { describe, expect, it } from "vitest";

import {
  buildSwarmLaunchRequest,
  createSwarmLaunchForm,
  parseTokenAmount,
  previewSwarmWorkerModels,
} from "../src/app/swarmLaunch";

describe("parseTokenAmount", () => {
  it.each([
    ["2000000", 2_000_000],
    ["2,000,000", 2_000_000],
    ["2_000_000", 2_000_000],
    ["500k", 500_000],
    ["2M", 2_000_000],
    ["1.5m", 1_500_000],
    [" 750 K ", 750_000],
  ])("reads %s", (input, expected) => {
    expect(parseTokenAmount(input)).toBe(expected);
  });

  it.each(["", "lots", "-5", "2mm", "1e6"])("rejects %s", (input) => {
    expect(parseTokenAmount(input)).toBeNull();
  });
});

describe("buildSwarmLaunchRequest", () => {
  it("defaults to auto worker routing with no budget", () => {
    expect(buildSwarmLaunchRequest(createSwarmLaunchForm("worktree"))).toEqual({
      request: { workspaceMode: "worktree", workerModel: "auto" },
      error: null,
    });
  });

  it("includes coordinator model, budget, retries, and resume when set", () => {
    const form = {
      ...createSwarmLaunchForm("shared"),
      workerModel: "haiku",
      coordinatorModel: "opus",
      budgetEnabled: true,
      budgetInput: "2M",
      maxAttempts: 2,
      resume: true,
    };
    expect(buildSwarmLaunchRequest(form)).toEqual({
      request: {
        workspaceMode: "shared",
        workerModel: "haiku",
        coordinatorModel: "opus",
        budgetTokens: 2_000_000,
        maxAttempts: 2,
        resume: true,
      },
      error: null,
    });
  });

  it("omits models left on the CLI default", () => {
    const form = { ...createSwarmLaunchForm("shared"), workerModel: "", coordinatorModel: "" };
    expect(buildSwarmLaunchRequest(form).request).toEqual({ workspaceMode: "shared" });
  });

  it("ignores retries without a budget, since only a budget can trigger one", () => {
    const form = { ...createSwarmLaunchForm("shared"), maxAttempts: 3 };
    expect(buildSwarmLaunchRequest(form).request).not.toHaveProperty("maxAttempts");
  });

  it("explains an unreadable or too-small budget instead of sending it", () => {
    const unreadable = {
      ...createSwarmLaunchForm("shared"),
      budgetEnabled: true,
      budgetInput: "a lot",
    };
    expect(buildSwarmLaunchRequest(unreadable)).toEqual({
      request: null,
      error: expect.stringMatching(/budget/i),
    });
    const tiny = { ...createSwarmLaunchForm("shared"), budgetEnabled: true, budgetInput: "500" };
    expect(buildSwarmLaunchRequest(tiny).error).toMatch(/1,000/);
  });
});

describe("previewSwarmWorkerModels", () => {
  const todoItems = [
    { text: "Fix typo in README", done: false },
    { text: "Refactor the session runtime", done: false },
    { text: "Already shipped", done: true },
  ];

  it("shows the model each open item will get under auto routing, with the reason", () => {
    expect(previewSwarmWorkerModels(todoItems, "auto")).toEqual([
      { index: 0, text: "Fix typo in README", model: "haiku", reason: 'mentions "typo"' },
      {
        index: 1,
        text: "Refactor the session runtime",
        model: "sonnet",
        reason: 'mentions "refactor"',
      },
    ]);
  });

  it("shows one model for every item when a specific model is chosen", () => {
    expect(previewSwarmWorkerModels(todoItems, "opus").map((row) => row.model)).toEqual([
      "opus",
      "opus",
    ]);
    expect(previewSwarmWorkerModels(todoItems, "").map((row) => row.model)).toEqual([
      "default",
      "default",
    ]);
  });
});
