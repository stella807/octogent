import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSeenStore } from "../src/store.ts";

const tempFile = async (name = "state.json"): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "bounty-watch-")), name);

describe("FileSeenStore", () => {
  it("treats a missing file as a cold start", async () => {
    const store = new FileSeenStore(await tempFile());
    expect(await store.load()).toEqual(new Set());
  });

  it("round-trips ids", async () => {
    const store = new FileSeenStore(await tempFile());
    await store.save(["b", "a"]);
    expect(await store.load()).toEqual(new Set(["a", "b"]));
  });

  it("creates missing parent directories", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "bounty-watch-")),
      "nested",
      "deep",
      "state.json",
    );
    const store = new FileSeenStore(path);
    await store.save(["a"]);
    expect(await store.load()).toEqual(new Set(["a"]));
  });

  it("recovers from a corrupt state file instead of crashing the poller", async () => {
    const path = await tempFile();
    await writeFile(path, "{ not json", "utf8");
    expect(await new FileSeenStore(path).load()).toEqual(new Set());
  });

  it("ignores non-string entries in a hand-edited file", async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify({ version: 1, ids: ["a", 7, null] }), "utf8");
    expect(await new FileSeenStore(path).load()).toEqual(new Set(["a"]));
  });

  it("writes deterministic, diff-friendly output", async () => {
    const path = await tempFile();
    await new FileSeenStore(path).save(["c", "a", "b"]);
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify({ version: 1, ids: ["a", "b", "c"] }, null, 2)}\n`,
    );
  });
});
