import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SwarmItemStatus = "waiting" | "working" | "done";

export type SwarmProgressNote = { at: string; from: string; text: string };

export type SwarmProgressItem = {
  index: number;
  text: string;
  status: SwarmItemStatus;
  /** The terminal currently (or last) holding the item. */
  terminalId?: string;
  /** Attempt in which the item was last assigned or finished. */
  attempt: number;
  notes: SwarmProgressNote[];
  doneAt?: string;
};

export type SwarmProgressLedger = {
  version: 1;
  tentacleId: string;
  startedAt: string;
  updatedAt: string;
  /** Every coordinator this swarm has had; DONE/PROGRESS sent to any of them counts. */
  parentTerminalIds: string[];
  items: SwarmProgressItem[];
};

export type SwarmAttemptStart = {
  attempt: number;
  parentTerminalId: string | null;
  /** Items this attempt covers, in priority order. */
  items: Array<{ index: number; text: string }>;
  /** Items handed straight to a worker; the rest wait in the queue. */
  assignments: Array<{ terminalId: string; index: number }>;
  /**
   * Keep an existing ledger's done items and notes. Defaults to true for
   * retries (attempt > 1); a fresh swarm starts a fresh ledger unless resuming.
   */
  continueExisting?: boolean;
};

// Tentacle ids become file names under the state directory.
const SAFE_TENTACLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isSafeTentacleId = (tentacleId: string) =>
  SAFE_TENTACLE_ID.test(tentacleId) && !tentacleId.includes("..");

export const SWARM_PROGRESS_REPORT_FILE = "swarm-progress.md";

const renderMarkdown = (ledger: SwarmProgressLedger): string => {
  const done = ledger.items.filter((item) => item.status === "done").length;
  const lines = [
    "# Swarm progress",
    "",
    `${done} of ${ledger.items.length} item(s) reported done. Updated ${ledger.updatedAt}.`,
    "",
    "Kept by Octogent from workers' DONE and PROGRESS messages. Done means the worker reported it, not that the coordinator has reviewed or merged it.",
    "",
  ];
  for (const item of ledger.items) {
    const holder =
      item.status === "done"
        ? ` (done in attempt ${item.attempt})`
        : item.status === "working" && item.terminalId
          ? ` (working: \`${item.terminalId}\`)`
          : item.terminalId
            ? ` (waiting; last worked on by \`${item.terminalId}\`)`
            : " (waiting)";
    lines.push(`- [${item.status === "done" ? "x" : " "}] #${item.index} ${item.text}${holder}`);
    for (const note of item.notes)
      lines.push(`  - ${note.at.slice(0, 16)} ${note.from}: ${note.text}`);
  }
  return `${lines.join("\n")}\n`;
};

/**
 * Durable record of what a swarm has finished and how far it got on the rest.
 *
 * Built only from signals agents already send (queue claims and DONE/PROGRESS
 * channel messages), so it costs no tokens. It is what lets a budget retry or
 * a resumed swarm continue instead of redoing work, and it is written to disk
 * so an API restart, which ends every agent session, does not erase it.
 */
export const createSwarmProgressStore = ({
  workspaceCwd,
  stateDir,
}: {
  workspaceCwd: string;
  stateDir: string;
}) => {
  const ledgers = new Map<string, SwarmProgressLedger>();
  const tentacleByParent = new Map<string, string>();

  const ledgerPath = (tentacleId: string) =>
    join(stateDir, "state", "swarms", `${tentacleId}.json`);

  const persist = (ledger: SwarmProgressLedger) => {
    ledger.updatedAt = new Date().toISOString();
    const path = ledgerPath(ledger.tentacleId);
    try {
      mkdirSync(dirname(path), { recursive: true });
      // Write-then-rename so a crash mid-write never leaves a truncated ledger.
      writeFileSync(`${path}.tmp`, JSON.stringify(ledger, null, 2), "utf8");
      renameSync(`${path}.tmp`, path);
      const tentacleDir = join(workspaceCwd, ".octogent", "tentacles", ledger.tentacleId);
      if (existsSync(tentacleDir)) {
        writeFileSync(
          join(tentacleDir, SWARM_PROGRESS_REPORT_FILE),
          renderMarkdown(ledger),
          "utf8",
        );
      }
    } catch {
      // The in-memory ledger still drives retries; disk is for restarts.
    }
  };

  const read = (tentacleId: string): SwarmProgressLedger | null => {
    if (!isSafeTentacleId(tentacleId)) return null;
    const cached = ledgers.get(tentacleId);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(
        readFileSync(ledgerPath(tentacleId), "utf8"),
      ) as SwarmProgressLedger;
      if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return null;
      ledgers.set(tentacleId, parsed);
      for (const parent of parsed.parentTerminalIds ?? []) tentacleByParent.set(parent, tentacleId);
      return parsed;
    } catch {
      return null;
    }
  };

  const heldBy = (ledger: SwarmProgressLedger, terminalId: string) =>
    ledger.items.filter((item) => item.status === "working" && item.terminalId === terminalId);

  return {
    read,

    startAttempt(tentacleId: string, start: SwarmAttemptStart) {
      if (!isSafeTentacleId(tentacleId)) return;
      const continueExisting = start.continueExisting ?? start.attempt > 1;
      const existing = continueExisting ? read(tentacleId) : null;
      const now = new Date().toISOString();
      const ledger: SwarmProgressLedger = existing ?? {
        version: 1,
        tentacleId,
        startedAt: now,
        updatedAt: now,
        parentTerminalIds: [],
        items: [],
      };
      if (!existing) {
        for (const [parent, owner] of tentacleByParent) {
          if (owner === tentacleId) tentacleByParent.delete(parent);
        }
      }

      const assignedTo = new Map(start.assignments.map((a) => [a.index, a.terminalId]));
      for (const { index, text } of start.items) {
        let item = ledger.items.find((i) => i.index === index && i.text === text);
        if (!item) {
          item = { index, text, status: "waiting", attempt: start.attempt, notes: [] };
          ledger.items.push(item);
        }
        if (item.status === "done") continue;
        const terminalId = assignedTo.get(index);
        item.status = terminalId ? "working" : "waiting";
        item.attempt = start.attempt;
        // A waiting item keeps its last holder: useful history, and the status
        // alone decides how it is shown and whether it can be claimed.
        if (terminalId) item.terminalId = terminalId;
      }
      ledger.items.sort((a, b) => a.index - b.index);

      if (start.parentTerminalId && !ledger.parentTerminalIds.includes(start.parentTerminalId)) {
        ledger.parentTerminalIds.push(start.parentTerminalId);
      }
      for (const parent of ledger.parentTerminalIds) tentacleByParent.set(parent, tentacleId);
      ledgers.set(tentacleId, ledger);
      persist(ledger);
    },

    recordClaim(tentacleId: string, terminalId: string, index: number) {
      const ledger = read(tentacleId);
      const item = ledger?.items.find((i) => i.index === index && i.status !== "done");
      if (!ledger || !item) return;
      item.status = "working";
      item.terminalId = terminalId;
      persist(ledger);
    },

    /** Observes a channel message; only DONE/PROGRESS to a swarm coordinator matter. */
    recordMessage(toTerminalId: string, fromTerminalId: string, content: string) {
      const tentacleId = tentacleByParent.get(toTerminalId);
      const ledger = tentacleId ? read(tentacleId) : null;
      if (!ledger) return;

      const match = /^(DONE|PROGRESS):\s*([\s\S]*)$/.exec(content.trim());
      if (!match) return;
      const [, kind, rawText] = match;
      const text = (rawText ?? "").trim();
      const held = heldBy(ledger, fromTerminalId);
      // Workers paraphrase, so prefer the item they hold whose text they echo,
      // then any open item they echo, then their single held item.
      const echoes = (item: SwarmProgressItem) => text.startsWith(item.text.trim());
      const item =
        held.find(echoes) ??
        ledger.items.find((i) => i.status !== "done" && echoes(i)) ??
        (held.length === 1 ? held[0] : undefined);
      if (!item) return;

      if (kind === "DONE") {
        item.status = "done";
        item.doneAt = new Date().toISOString();
        item.terminalId = fromTerminalId;
      } else if (text.length > 0) {
        item.notes.push({ at: new Date().toISOString(), from: fromTerminalId, text });
      }
      persist(ledger);
    },

    /** Called when a swarm's agents are stopped: nothing is being worked on any more. */
    releaseWorking(tentacleId: string) {
      const ledger = read(tentacleId);
      if (!ledger) return;
      for (const item of ledger.items) {
        if (item.status === "working") item.status = "waiting";
      }
      persist(ledger);
    },

    doneIndices(tentacleId: string): number[] {
      return (read(tentacleId)?.items ?? [])
        .filter((item) => item.status === "done")
        .map((item) => item.index);
    },

    notesFor(tentacleId: string): Map<number, string[]> {
      const notes = new Map<number, string[]>();
      for (const item of read(tentacleId)?.items ?? []) {
        if (item.notes.length > 0)
          notes.set(
            item.index,
            item.notes.map((note) => note.text),
          );
      }
      return notes;
    },
  };
};

export type SwarmProgressStore = ReturnType<typeof createSwarmProgressStore>;
