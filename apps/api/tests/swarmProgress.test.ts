import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSwarmProgressStore } from "../src/deck/swarmProgress";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const setup = () => {
  const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-progress-"));
  directories.push(workspaceCwd);
  mkdirSync(join(workspaceCwd, ".octogent", "tentacles", "docs"), { recursive: true });
  const stateDir = join(workspaceCwd, ".octogent");
  const store = createSwarmProgressStore({ workspaceCwd, stateDir });
  store.startAttempt("docs", {
    attempt: 1,
    parentTerminalId: "docs-swarm-parent",
    items: [
      { index: 0, text: "write intro" },
      { index: 1, text: "fix links" },
      { index: 2, text: "add glossary" },
    ],
    assignments: [
      { terminalId: "docs-swarm-0", index: 0 },
      { terminalId: "docs-swarm-1", index: 1 },
    ],
  });
  return { workspaceCwd, stateDir, store };
};

describe("swarm progress ledger", () => {
  it("tracks who works on what, including queue claims", () => {
    const { store } = setup();
    store.recordClaim("docs", "docs-swarm-0", 2);

    expect(store.read("docs")?.items).toMatchObject([
      { index: 0, status: "working", terminalId: "docs-swarm-0" },
      { index: 1, status: "working", terminalId: "docs-swarm-1" },
      { index: 2, status: "working", terminalId: "docs-swarm-0" },
    ]);
  });

  it("marks items done from DONE messages sent to the coordinator", () => {
    const { store } = setup();
    store.recordMessage("docs-swarm-parent", "docs-swarm-1", "DONE: fix links");

    expect(store.read("docs")?.items[1]).toMatchObject({ status: "done", attempt: 1 });
    expect(store.doneIndices("docs")).toEqual([1]);
  });

  it("files PROGRESS notes under the item the sender is working on", () => {
    const { store } = setup();
    store.recordMessage(
      "docs-swarm-parent",
      "docs-swarm-0",
      "PROGRESS: intro drafted in docs/intro.md, examples still missing",
    );

    expect(store.notesFor("docs").get(0)).toEqual([
      "intro drafted in docs/intro.md, examples still missing",
    ]);
    expect(store.read("docs")?.items[0]?.status).toBe("working");
  });

  it("ignores messages that are not to a swarm coordinator or not DONE/PROGRESS", () => {
    const { store } = setup();
    store.recordMessage("someone-else", "docs-swarm-1", "DONE: fix links");
    store.recordMessage("docs-swarm-parent", "docs-swarm-1", "BLOCKED: need access");

    expect(store.doneIndices("docs")).toEqual([]);
  });

  it("keeps done items and notes when a retry reassigns the rest", () => {
    const { store } = setup();
    store.recordMessage("docs-swarm-parent", "docs-swarm-1", "DONE: fix links");
    store.recordMessage("docs-swarm-parent", "docs-swarm-0", "PROGRESS: half the intro");
    store.startAttempt("docs", {
      attempt: 2,
      parentTerminalId: "docs-swarm-a2-parent",
      items: [
        { index: 0, text: "write intro" },
        { index: 2, text: "add glossary" },
      ],
      assignments: [{ terminalId: "docs-swarm-a2-0", index: 0 }],
    });

    const ledger = store.read("docs");
    expect(ledger?.items).toMatchObject([
      { index: 0, status: "working", terminalId: "docs-swarm-a2-0", attempt: 2 },
      { index: 1, status: "done", attempt: 1 },
      { index: 2, status: "waiting" },
    ]);
    expect(store.notesFor("docs").get(0)).toEqual(["half the intro"]);
    // The new coordinator's messages now count too.
    store.recordMessage("docs-swarm-a2-parent", "docs-swarm-a2-0", "DONE: write intro");
    expect(store.doneIndices("docs")).toEqual([0, 1]);
  });

  it("survives a restart: a new store reads the ledger back from disk", () => {
    const { store, workspaceCwd, stateDir } = setup();
    store.recordMessage("docs-swarm-parent", "docs-swarm-1", "DONE: fix links");
    store.recordMessage("docs-swarm-parent", "docs-swarm-0", "PROGRESS: outline done");

    expect(existsSync(join(stateDir, "state", "swarms", "docs.json"))).toBe(true);
    const restarted = createSwarmProgressStore({ workspaceCwd, stateDir });
    expect(restarted.doneIndices("docs")).toEqual([1]);
    expect(restarted.notesFor("docs").get(0)).toEqual(["outline done"]);
  });

  it("writes a readable progress file into the tentacle folder", () => {
    const { store, workspaceCwd } = setup();
    store.recordMessage("docs-swarm-parent", "docs-swarm-1", "DONE: fix links");
    store.recordMessage("docs-swarm-parent", "docs-swarm-0", "PROGRESS: outline done");

    const markdown = readFileSync(
      join(workspaceCwd, ".octogent", "tentacles", "docs", "swarm-progress.md"),
      "utf8",
    );
    expect(markdown).toContain("[x] #1 fix links");
    expect(markdown).toContain("[ ] #0 write intro");
    expect(markdown).toContain("outline done");
  });

  it("refuses tentacle ids that could escape the state directory", () => {
    const { store, stateDir } = setup();
    store.startAttempt("../evil", {
      attempt: 1,
      parentTerminalId: "x-parent",
      items: [{ index: 0, text: "x" }],
      assignments: [],
    });
    expect(existsSync(join(stateDir, "state", "evil.json"))).toBe(false);
    expect(store.read("../evil")).toBeNull();
  });

  it("returns in-flight items to waiting when the swarm is stopped, keeping who last had them", () => {
    const { store, workspaceCwd } = setup();
    store.recordMessage("docs-swarm-parent", "docs-swarm-1", "DONE: fix links");
    store.releaseWorking("docs");

    expect(store.read("docs")?.items).toMatchObject([
      { index: 0, status: "waiting", terminalId: "docs-swarm-0" },
      { index: 1, status: "done" },
      { index: 2, status: "waiting" },
    ]);
    const markdown = readFileSync(
      join(workspaceCwd, ".octogent", "tentacles", "docs", "swarm-progress.md"),
      "utf8",
    );
    expect(markdown).toContain("#0 write intro (waiting; last worked on by `docs-swarm-0`)");
  });
});
