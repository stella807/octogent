import { closeSync, fstatSync, openSync, readSync } from "node:fs";

type TranscriptCursor = {
  offset: number;
  partialLine: string;
  total: number;
  seenMessageIds: Set<string>;
};

type AssistantUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

const tokensIn = (usage: AssistantUsage): number =>
  (usage.input_tokens ?? 0) +
  (usage.output_tokens ?? 0) +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0);

/**
 * Running token totals for Claude Code transcripts (`~/.claude/projects/...jsonl`).
 *
 * Tokens are counted the same way as the usage chart: input, output, and both
 * cache fields. It is called on every tool call of every budgeted agent, so it
 * reads only bytes appended since the last call instead of the whole file.
 */
export const createTranscriptUsageReader = () => {
  const cursors = new Map<string, TranscriptCursor>();

  const consumeLine = (cursor: TranscriptCursor, line: string) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as { type?: unknown; message?: { id?: unknown; usage?: unknown } };
    if (record.type !== "assistant") return;
    const usage = record.message?.usage;
    if (!usage || typeof usage !== "object") return;

    // Claude writes each content block of one reply as its own line, all with
    // the same message id and usage, so counting every line overcounts.
    const messageId = record.message?.id;
    if (typeof messageId === "string") {
      if (cursor.seenMessageIds.has(messageId)) return;
      cursor.seenMessageIds.add(messageId);
    }
    cursor.total += tokensIn(usage as AssistantUsage);
  };

  return {
    read(transcriptPath: string): number {
      let cursor = cursors.get(transcriptPath);
      if (!cursor) {
        cursor = { offset: 0, partialLine: "", total: 0, seenMessageIds: new Set() };
        cursors.set(transcriptPath, cursor);
      }

      let fd: number;
      try {
        fd = openSync(transcriptPath, "r");
      } catch {
        return cursor.total;
      }
      try {
        const size = fstatSync(fd).size;
        if (size <= cursor.offset) return cursor.total;
        const buffer = Buffer.alloc(size - cursor.offset);
        const bytesRead = readSync(fd, buffer, 0, buffer.length, cursor.offset);
        cursor.offset += bytesRead;

        const text = cursor.partialLine + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        // The last element is an incomplete line (or "") still being written.
        cursor.partialLine = lines.pop() ?? "";
        for (const line of lines) consumeLine(cursor, line);
      } catch {
        // A transcript mid-rotation is retried on the next hook.
      } finally {
        closeSync(fd);
      }
      return cursor.total;
    },
  };
};

export type TranscriptUsageReader = ReturnType<typeof createTranscriptUsageReader>;
