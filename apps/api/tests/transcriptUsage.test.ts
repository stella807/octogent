import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTranscriptUsageReader } from "../src/terminalRuntime/transcriptUsage";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const transcriptFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "octogent-usage-"));
  directories.push(directory);
  return join(directory, "session.jsonl");
};

const assistantLine = (id: string, usage: Record<string, number>) =>
  `${JSON.stringify({ type: "assistant", message: { id, usage } })}\n`;

describe("transcript usage reader", () => {
  it("sums input, output, and cache tokens across assistant messages", () => {
    const path = transcriptFile();
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n${assistantLine("m1", { input_tokens: 10, output_tokens: 5 })}${assistantLine(
        "m2",
        {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
        },
      )}`,
    );

    expect(createTranscriptUsageReader().read(path)).toBe(1118);
  });

  it("counts a message once even when Claude logs it over several lines", () => {
    const path = transcriptFile();
    // Each content block of one reply is its own line carrying the same usage.
    writeFileSync(
      path,
      assistantLine("m1", { input_tokens: 10, output_tokens: 5 }) +
        assistantLine("m1", { input_tokens: 10, output_tokens: 5 }),
    );

    expect(createTranscriptUsageReader().read(path)).toBe(15);
  });

  it("reads only the new bytes on each call and keeps a running total", () => {
    const path = transcriptFile();
    const reader = createTranscriptUsageReader();
    writeFileSync(path, assistantLine("m1", { output_tokens: 7 }));
    expect(reader.read(path)).toBe(7);

    // A line written in two chunks must not be counted until it is complete.
    const line = assistantLine("m2", { output_tokens: 3 });
    appendFileSync(path, line.slice(0, 20));
    expect(reader.read(path)).toBe(7);
    appendFileSync(path, line.slice(20));
    expect(reader.read(path)).toBe(10);
  });

  it("treats a missing or unreadable transcript as zero rather than throwing", () => {
    expect(createTranscriptUsageReader().read("/nonexistent/session.jsonl")).toBe(0);
  });
});
