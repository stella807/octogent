import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TentacleWorkspaceMode, TerminalAgentProvider } from "@octogent/core";

import type { SwarmBudgetSnapshot, SwarmBudgetStore } from "../deck/swarmBudget";
import type { SwarmProgressStore } from "../deck/swarmProgress";
import { logVerbose } from "../logging";
import type { TranscriptUsageReader } from "../terminalRuntime/transcriptUsage";
import { type SwarmLaunchDependencies, launchSwarm, swarmTerminalPrefix } from "./swarmLauncher";

type SwarmItem = { index: number; text: string };

export type BudgetedSwarmSettings = {
  items: SwarmItem[];
  workerWorkspaceMode: TentacleWorkspaceMode;
  agentProvider?: TerminalAgentProvider | undefined;
  workerModel?: string | undefined;
  coordinatorModel?: string | undefined;
};

const formatTokens = (tokens: number) => tokens.toLocaleString("en-US");

export const SWARM_BUDGET_REPORT_FILE = "swarm-budget.md";

/** Coordinator prompt section for a budgeted attempt. */
export const buildBudgetSection = ({
  budgetTokens,
  attempt,
  maxAttempts,
  previous,
}: {
  budgetTokens: number;
  attempt: number;
  maxAttempts: number;
  previous?: { spentTokens: number; doneItems: SwarmItem[]; carriedBranches: string[] };
}): string => {
  const lines = [
    "## Token Budget",
    "",
    `This is attempt ${attempt} of ${maxAttempts}. You and every worker share one budget of ${formatTokens(budgetTokens)} tokens. When the combined total reaches it, Octogent stops all of you immediately, finished or not${attempt < maxAttempts ? ", and starts a fresh attempt on whatever is not done yet" : ", and the swarm ends for good"}.`,
    "",
    "Spend it deliberately: give workers precise instructions so they do not explore, avoid re-reading large files, keep channel messages short, and check on workers only when you need to.",
  ];
  if (previous) {
    lines.push(
      "",
      `### What happened in attempt ${attempt - 1}`,
      "",
      `It was stopped after spending ${formatTokens(previous.spentTokens)} tokens. The workers above only cover the items it did not finish.`,
    );
    if (previous.doneItems.length > 0) {
      lines.push(
        "",
        "Reported DONE in that attempt (do not redo these):",
        ...previous.doneItems.map((item) => `- item #${item.index}: ${item.text}`),
      );
    }
    if (previous.carriedBranches.length > 0) {
      lines.push(
        "",
        "Its workers' branches still hold their commits. Merge them together with this attempt's branches:",
        ...previous.carriedBranches.map((branch) => `- \`${branch}\``),
      );
    }
    lines.push("", "The last attempt ran out, so be more economical this time than it was.");
  }
  return lines.join("\n");
};

/**
 * Enforces swarm token budgets: counts each agent's transcript usage, and when
 * an attempt's shared total reaches the budget, stops every agent in it, then
 * either relaunches the unfinished items as a fresh attempt or ends the swarm.
 *
 * Agents are stopped, never deleted: deleting a worktree terminal removes its
 * worktree, which would throw away work the next attempt should merge.
 */
export const createSwarmBudgetEnforcer = ({
  launchDependencies,
  budgets,
  progress,
  usageReader,
}: {
  launchDependencies: SwarmLaunchDependencies;
  budgets: SwarmBudgetStore;
  progress: SwarmProgressStore;
  usageReader: TranscriptUsageReader;
}) => {
  const { runtime, workspaceCwd } = launchDependencies;
  const settingsByTentacle = new Map<string, BudgetedSwarmSettings>();
  // /clear and resumes start new transcript files for the same terminal.
  const transcriptPathsByTerminal = new Map<string, Set<string>>();
  const reportLog = new Map<string, string[]>();

  const writeReport = (tentacleId: string, entry: string) => {
    const entries = reportLog.get(tentacleId) ?? [];
    entries.push(entry);
    reportLog.set(tentacleId, entries);
    try {
      writeFileSync(
        join(workspaceCwd, ".octogent", "tentacles", tentacleId, SWARM_BUDGET_REPORT_FILE),
        `# Swarm budget report\n\n${entries.join("\n\n")}\n`,
        "utf8",
      );
    } catch (error) {
      logVerbose(`[Budget] could not write report for ${tentacleId}: ${String(error)}`);
    }
  };

  const findDoneItems = (tentacleId: string, items: SwarmItem[]): SwarmItem[] => {
    const done = new Set(progress.doneIndices(tentacleId));
    return items.filter((item) => done.has(item.index));
  };

  const describeAttempt = (snapshot: SwarmBudgetSnapshot, attempt: number) => {
    const record = snapshot.attempts[attempt - 1];
    const byAgent = Object.entries(record?.tokensByTerminal ?? {})
      .sort(([, a], [, b]) => b - a)
      .map(([terminalId, tokens]) => `  - \`${terminalId}\`: ${formatTokens(tokens)}`);
    return [
      `Spent ${formatTokens(record?.spentTokens ?? 0)} of ${formatTokens(snapshot.budgetTokens)} tokens.`,
      ...(byAgent.length > 0 ? ["- By agent:", ...byAgent] : []),
    ];
  };

  const handleExceeded = async (tentacleId: string, attempt: number) => {
    const settings = settingsByTentacle.get(tentacleId);
    const snapshot = budgets.snapshot(tentacleId);
    const record = snapshot?.attempts[attempt - 1];
    if (!settings || !snapshot || !record) return;

    for (const terminalId of record.terminalIds) {
      if (runtime.stopTerminal(terminalId)) {
        logVerbose(`[Budget] stopped ${terminalId} (${tentacleId} attempt ${attempt})`);
      }
    }

    progress.releaseWorking(tentacleId);

    const prefix = swarmTerminalPrefix(tentacleId, attempt);
    const parentTerminalId = record.terminalIds.find((id) => id === `${prefix}-parent`) ?? null;
    const doneItems = findDoneItems(tentacleId, settings.items);
    const remaining = settings.items.filter((item) => !doneItems.includes(item));
    const carriedBranches =
      settings.workerWorkspaceMode === "worktree"
        ? record.terminalIds
            .filter((id) => id !== parentTerminalId)
            .filter((id) => runtime.listTerminalSnapshots().some((t) => t.terminalId === id))
            .map((id) => `octogent/${id}`)
        : [];

    const heading = `## Attempt ${attempt} of ${snapshot.maxAttempts}: stopped at budget`;
    const facts = [
      ...describeAttempt(snapshot, attempt),
      `- Reported DONE: ${doneItems.length === 0 ? "none" : doneItems.map((i) => `#${i.index}`).join(", ")}`,
      `- Not finished: ${remaining.length === 0 ? "none" : remaining.map((i) => `#${i.index} ${i.text}`).join("; ")}`,
    ];

    if (remaining.length > 0 && budgets.canRetry(tentacleId)) {
      const nextAttempt = attempt + 1;
      try {
        budgets.setOutcome(tentacleId, "retrying");
        const result = await launchSwarm(launchDependencies, {
          tentacleId,
          items: remaining,
          workerWorkspaceMode: settings.workerWorkspaceMode,
          agentProvider: settings.agentProvider,
          workerModel: settings.workerModel,
          coordinatorModel: settings.coordinatorModel,
          attempt: nextAttempt,
          itemNotes: progress.notesFor(tentacleId),
          budgetSection: buildBudgetSection({
            budgetTokens: snapshot.budgetTokens,
            attempt: nextAttempt,
            maxAttempts: snapshot.maxAttempts,
            previous: { spentTokens: record.spentTokens, doneItems, carriedBranches },
          }),
        });
        budgets.startAttempt(tentacleId, result.terminalIds);
        progress.startAttempt(tentacleId, {
          attempt: nextAttempt,
          parentTerminalId: result.parentTerminalId,
          items: remaining,
          assignments: result.workers.map((w) => ({
            terminalId: w.terminalId,
            index: w.todoIndex,
          })),
        });
        settingsByTentacle.set(tentacleId, { ...settings, items: remaining });
        writeReport(
          tentacleId,
          [
            heading,
            "",
            ...facts,
            "",
            `Retrying the unfinished items as attempt ${nextAttempt} with a fresh ${formatTokens(snapshot.budgetTokens)}-token budget.`,
          ].join("\n"),
        );
        return;
      } catch (error) {
        facts.push(
          `- The retry could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    budgets.setOutcome(tentacleId, "exhausted");
    const advice =
      remaining.length === 0
        ? "Every item was reported DONE, but the budget ran out before the coordinator finished reviewing and merging. Review the changes yourself, or raise the budget."
        : "The swarm is stopped for good. Raise the budget, or split the unfinished items into smaller, more precise todo items, then start a new swarm.";
    writeReport(tentacleId, [heading, "", ...facts, "", advice].join("\n"));
  };

  return {
    register(tentacleId: string, settings: BudgetedSwarmSettings) {
      settingsByTentacle.set(tentacleId, settings);
      reportLog.delete(tentacleId);
    },

    unregister(tentacleId: string) {
      settingsByTentacle.delete(tentacleId);
    },

    recordTranscriptActivity(terminalId: string, transcriptPath: string) {
      if (!budgets.tracks(terminalId)) return;
      const paths = transcriptPathsByTerminal.get(terminalId) ?? new Set<string>();
      paths.add(transcriptPath);
      transcriptPathsByTerminal.set(terminalId, paths);
      let total = 0;
      for (const path of paths) total += usageReader.read(path);
      budgets.recordUsage(terminalId, total);
    },

    /**
     * At the warning threshold, asks every agent in the attempt to wind down
     * and checkpoint, so a hard stop that follows loses as little as possible.
     */
    handleWarning(tentacleId: string, attempt: number) {
      const snapshot = budgets.snapshot(tentacleId);
      const record = snapshot?.attempts[attempt - 1];
      if (!snapshot || !record) return;
      const parentTerminalId = `${swarmTerminalPrefix(tentacleId, attempt)}-parent`;
      const hasParent = record.terminalIds.includes(parentTerminalId);
      const used = `${formatTokens(record.spentTokens)} of ${formatTokens(snapshot.budgetTokens)}`;
      const workerMessage = hasParent
        ? `BUDGET WARNING: this swarm has used ${used} tokens. Do not start new work. Finish your current step (commit it in worktree mode), then report where you are: node bin/octogent channel send ${parentTerminalId} "PROGRESS: <what is done, what is left, which files>" --from <your terminal id>. If your item is complete, report DONE instead. Then wait.`
        : `BUDGET WARNING: this swarm has used ${used} tokens. Do not start new work. Finish your current step and commit it if you are in a worktree, then stop.`;
      const parentMessage = `BUDGET WARNING: this swarm has used ${used} tokens. Workers have been told to checkpoint. Do not start reviews, merges, or new instructions now; if the budget runs out, Octogent stops everyone and keeps the workers' PROGRESS notes for ${attempt < snapshot.maxAttempts ? "the next attempt" : "a later resume"}.`;

      for (const terminalId of record.terminalIds) {
        const sent = runtime.sendChannelMessage(
          terminalId,
          "octogent",
          terminalId === parentTerminalId ? parentMessage : workerMessage,
        );
        if (sent) logVerbose(`[Budget] warned ${terminalId} (${tentacleId} attempt ${attempt})`);
      }
    },

    handleExceeded(tentacleId: string, attempt: number) {
      // Runs outside the hook request: stopping agents and relaunching must not
      // hold up the HTTP response Claude's hook is waiting on.
      setImmediate(() => {
        handleExceeded(tentacleId, attempt).catch((error: unknown) => {
          budgets.setOutcome(tentacleId, "exhausted");
          logVerbose(`[Budget] enforcement failed for ${tentacleId}: ${String(error)}`);
        });
      });
    },
  };
};

export type SwarmBudgetEnforcer = ReturnType<typeof createSwarmBudgetEnforcer>;
