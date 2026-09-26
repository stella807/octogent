import { join } from "node:path";

import type { TentacleWorkspaceMode, TerminalAgentProvider } from "@octogent/core";

import { readDeckTentacles } from "../deck/readDeckTentacles";
import type { SwarmQueueItem } from "../deck/swarmQueue";
import { resolvePrompt } from "../prompts";
import { MAX_CHILDREN_PER_PARENT, RuntimeInputError } from "../terminalRuntime";
import type { RouteHandlerDependencies } from "./routeHelpers";

export const shellSingleQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export type SwarmLaunchDependencies = Pick<
  RouteHandlerDependencies,
  "runtime" | "workspaceCwd" | "projectStateDir" | "promptsDir" | "getApiPort" | "swarmQueues"
>;

export type SwarmLaunchOptions = {
  tentacleId: string;
  /** Incomplete todo items in priority (todo) order. */
  items: Array<{ index: number; text: string }>;
  workerWorkspaceMode: TentacleWorkspaceMode;
  agentProvider?: TerminalAgentProvider | undefined;
  workerModel?: string | undefined;
  coordinatorModel?: string | undefined;
  /** 1 for a fresh swarm; budget retries use 2+ and get distinct terminal ids. */
  attempt?: number;
  /** Markdown telling the coordinator about its token budget and any earlier attempt. */
  budgetSection?: string;
  /** PROGRESS notes left on items by earlier attempts, keyed by todo index. */
  itemNotes?: ReadonlyMap<number, readonly string[]>;
};

export type SwarmLaunchResult = {
  tentacleId: string;
  parentTerminalId: string | null;
  workers: Array<{ terminalId: string; todoIndex: number; todoText: string }>;
  queuedItems: SwarmQueueItem[];
  /** Every terminal this swarm will run, including workers the coordinator spawns later. */
  terminalIds: string[];
};

/** Terminal id prefix for a swarm attempt. Attempt 1 keeps the original ids. */
export const swarmTerminalPrefix = (tentacleId: string, attempt: number) =>
  attempt > 1 ? `${tentacleId}-swarm-a${attempt}` : `${tentacleId}-swarm`;

/**
 * Starts a swarm over `items`: one worker per item up to the child cap, the
 * rest queued, and a coordinator when there is more than one item.
 *
 * Shared by the swarm route and budget retries so both launch identically.
 * Throws RuntimeInputError for caller-fixable problems.
 */
export const launchSwarm = async (
  {
    runtime,
    workspaceCwd,
    projectStateDir,
    promptsDir,
    getApiPort,
    swarmQueues,
  }: SwarmLaunchDependencies,
  {
    tentacleId,
    items,
    workerWorkspaceMode,
    agentProvider,
    workerModel,
    coordinatorModel,
    attempt = 1,
    budgetSection,
    itemNotes,
  }: SwarmLaunchOptions,
): Promise<SwarmLaunchResult> => {
  if (items.length === 0) {
    throw new RuntimeInputError("No incomplete todo items found.");
  }
  const idPrefix = swarmTerminalPrefix(tentacleId, attempt);

  // Earlier attempts' checkpoints travel with the item, so its new worker
  // continues from them instead of starting the item over.
  const buildEarlierProgressSection = (index: number): string => {
    const notes = itemNotes?.get(index) ?? [];
    if (notes.length === 0) return "";
    return [
      "",
      "## Progress From An Earlier Attempt",
      "",
      "A previous worker started this item and left these notes before it was stopped. Check the current state of the files, then continue from there rather than starting over:",
      ...notes.map((note) => `- ${note}`),
    ].join("\n");
  };

  // Todo order is priority order: the first items get a worker each, and the
  // overflow waits in the swarm queue for whichever worker finishes first.
  const queuedItems = items
    .slice(MAX_CHILDREN_PER_PARENT)
    .map((item) => ({ todoIndex: item.index, todoText: item.text }));
  const targetItems = items.slice(0, MAX_CHILDREN_PER_PARENT);

  // Determine base ref: use tentacle's worktree branch if it exists, otherwise HEAD.
  const existingTerminals = runtime.listTerminalSnapshots();
  const tentacleTerminal = existingTerminals.find(
    (t) => t.tentacleId === tentacleId && t.workspaceMode === "worktree",
  );
  const baseRef = tentacleTerminal ? `octogent/${tentacleId}` : "HEAD";

  // Resolve the tentacle display name for prompts.
  const deckTentacles = readDeckTentacles(workspaceCwd, projectStateDir);
  const deckEntry = deckTentacles.find((t) => t.tentacleId === tentacleId);
  const tentacleName = deckEntry?.displayName ?? tentacleId;

  const apiPort = getApiPort();
  const needsParent = targetItems.length > 1;
  const parentTerminalId = needsParent ? `${idPrefix}-parent` : null;
  const tentacleContextPath = join(workspaceCwd, ".octogent/tentacles", tentacleId);
  const workers = targetItems.map((item) => ({
    terminalId: `${idPrefix}-${item.index}`,
    todoIndex: item.index,
    todoText: item.text,
  }));

  const buildWorkerContextIntro = (): string =>
    workerWorkspaceMode === "worktree"
      ? "You are working on an isolated worktree branch, not the main branch."
      : "You are working in the shared main workspace on the main branch, not in an isolated worktree.";

  const buildWorkerGuidelines = (terminalId: string): string =>
    workerWorkspaceMode === "worktree"
      ? `- You are working in an isolated git worktree on branch \`octogent/${terminalId}\`. Make changes freely without worrying about conflicts with other agents.`
      : [
          "- You are working in the shared main workspace. Other workers may touch the same files, so keep your edits narrow, avoid broad refactors, and coordinate via your parent if you hit overlap.",
          "- Do NOT create commits in shared mode. Leave your changes uncommitted for the coordinator to review and commit later.",
          "- Do NOT mark todo items done or rewrite tentacle context files unless your assigned todo item explicitly requires it. The coordinator handles the final tentacle-level sync.",
        ].join("\n");

  const buildWorkerCommitGuidance = (): string =>
    workerWorkspaceMode === "worktree"
      ? "- Commit your changes with a clear commit message describing what you did."
      : "- Do NOT commit in shared mode. Leave your completed changes uncommitted and report DONE with a short summary of what changed.";

  const buildWorkerDefinitionOfDoneCommitStep = (): string =>
    workerWorkspaceMode === "worktree"
      ? "Changes are committed with a descriptive message."
      : "Changes are left uncommitted in the shared workspace, ready for coordinator review.";

  const buildWorkerReminder = (): string =>
    workerWorkspaceMode === "worktree" ? "Commit." : "Do not commit in shared mode.";

  const buildWorkerWorkspaceSection = (): string =>
    workerWorkspaceMode === "worktree"
      ? [
          "Each worker commits to its own isolated branch:",
          "",
          ...workers.map(
            (w) => `- \`octogent/${w.terminalId}\` — item #${w.todoIndex}: ${w.todoText}`,
          ),
        ].join("\n")
      : [
          "Workers are running in the shared main workspace, not in separate worktrees.",
          "",
          "There are no per-worker branches for this swarm. Supervise them carefully to avoid overlapping edits in the same files.",
        ].join("\n");

  const buildCompletionStrategySection = (baseBranch: string): string =>
    workerWorkspaceMode === "worktree"
      ? [
          `Only begin merging after ALL ${workers.length} workers have reported FINISHED (every item done and the swarm queue drained).`,
          "",
          "### Step-by-step merge process",
          "",
          `1. **Create an integration branch** from \`${baseBranch}\`. First check if a stale integration branch exists from a previous swarm attempt — if so, delete it before proceeding:`,
          "   ```bash",
          `   git branch -D octogent_integration_${tentacleId} 2>/dev/null || true`,
          `   git checkout ${baseBranch}`,
          `   git checkout -b octogent_integration_${tentacleId}`,
          "   ```",
          "",
          "2. **Merge each worker branch** into the integration branch one at a time. Start with the branch most likely to merge cleanly (fewest changes):",
          "   ```bash",
          "   git merge <worker-branch-name> --no-edit",
          "   ```",
          "   If there are conflicts, resolve them carefully. Read the conflicting files and understand both sides before choosing.",
          "",
          "3. **Run tests** on the integration branch after all merges. Do not skip this step.",
          "",
          "4. **If tests pass**, merge the integration branch into the base branch:",
          "   ```bash",
          `   git checkout ${baseBranch}`,
          `   git merge octogent_integration_${tentacleId} --no-edit`,
          "   ```",
          "",
          "5. **If tests fail**, investigate and fix before merging. Do not merge broken code.",
          "",
          `6. **Update tentacle state/docs** before finalizing. Mark completed items as done in \`.octogent/tentacles/${tentacleId}/todo.md\`, and update \`.octogent/tentacles/${tentacleId}/CONTEXT.md\` or other tentacle markdown files if the merged work changed the reality they describe.`,
          "",
          "7. **Clean up** the integration branch:",
          "   ```bash",
          `   git branch -d octogent_integration_${tentacleId}`,
          "   ```",
          "",
          "### Merge failure recovery",
          "",
          "If a worker's branch has conflicts that are too complex to resolve, send a message to that worker asking them to rebase their work. Merge the other workers' branches first.",
        ].join("\n")
      : [
          `Only begin final verification after ALL ${workers.length} workers have reported FINISHED (every item done and the swarm queue drained).`,
          "",
          "Workers are sharing the main workspace, so there are no per-worker branches to merge.",
          "",
          "### Step-by-step completion process",
          "",
          `1. **Verify the workspace is on \`${baseBranch}\`** and review the overall diff carefully. Do not assume the combined result is safe just because workers reported DONE.`,
          "",
          "2. **Review the changed files** to ensure workers did not overwrite each other or leave partial edits.",
          "",
          "3. **Run tests** on the shared workspace after all workers report DONE. Do not skip this step.",
          "",
          "4. **If tests fail**, investigate and coordinate fixes. Do not declare the swarm complete while the workspace is broken.",
          "",
          `5. **Update tentacle state/docs** before asking for approval. Mark completed items as done in \`.octogent/tentacles/${tentacleId}/todo.md\`, and update \`.octogent/tentacles/${tentacleId}/CONTEXT.md\` or other tentacle markdown files if the completed work changed the reality they describe. If no tentacle docs need updates, say that explicitly.`,
          "",
          "6. **Wait for explicit user approval** before creating any commit on the shared main branch. Present a concise summary of the reviewed diff, test results, and tentacle-doc updates first.",
          "",
          "7. **Only after approval, create one final commit** on the shared branch that captures the swarm's completed work.",
          "",
          "8. **Report completion** only after the shared workspace is reviewed, tests pass, tentacle docs are synced, approval is granted, and the final commit is created.",
          "",
          "### Shared-workspace failure recovery",
          "",
          "If two workers collide in the same files, stop them from making broad new edits, inspect the current diff, and coordinate targeted follow-up changes instead of pretending there is a clean merge boundary.",
        ].join("\n");

  const buildQueueSection = (): string =>
    queuedItems.length === 0
      ? "Every in-scope item has its own worker, so the swarm queue is empty. Workers will still run `swarm claim`, get `QUEUE EMPTY`, and report FINISHED."
      : [
          `${queuedItems.length} more item(s) did not get their own worker. They wait in the swarm queue, and each worker claims the next one itself after reporting DONE, reusing its warm session instead of a new one:`,
          "",
          ...queuedItems.map((item) => `- item #${item.todoIndex}: ${item.todoText}`),
          "",
          "Do not spawn extra workers for these and do not assign them by message. Check who holds what with:",
          "```bash",
          `node bin/octogent swarm queue ${tentacleId}`,
          "```",
        ].join("\n");

  if (!needsParent) {
    const [item] = targetItems;
    const [worker] = workers;
    if (!item || !worker) {
      throw new RuntimeInputError("No incomplete todo items found.");
    }

    const workerPrompt = await resolvePrompt(promptsDir, "swarm-worker", {
      tentacleName,
      tentacleId,
      tentacleContextPath,
      todoItemText: item.text,
      terminalId: worker.terminalId,
      apiPort,
      workspaceContextIntro: buildWorkerContextIntro(),
      workspaceGuidelines: buildWorkerGuidelines(worker.terminalId),
      commitGuidance: buildWorkerCommitGuidance(),
      definitionOfDoneCommitStep: buildWorkerDefinitionOfDoneCommitStep(),
      workspaceReminder: buildWorkerReminder(),
      parentTerminalId: "",
      parentSection: buildEarlierProgressSection(item.index),
    });

    runtime.createTerminal({
      terminalId: worker.terminalId,
      tentacleId,
      ...(workerWorkspaceMode === "worktree" ? { worktreeId: worker.terminalId } : {}),
      tentacleName,
      nameOrigin: "generated",
      autoRenamePromptContext: item.text,
      workspaceMode: workerWorkspaceMode,
      ...(agentProvider ? { agentProvider: agentProvider } : {}),
      ...(workerModel ? { model: workerModel } : {}),
      ...(workerPrompt ? { initialPrompt: workerPrompt } : {}),
      ...(workerWorkspaceMode === "worktree" ? { baseRef } : {}),
    });
  }

  if (needsParent && parentTerminalId) {
    const workerListing = workers
      .map((w) => `- \`${w.terminalId}\` — item #${w.todoIndex}: ${w.todoText}`)
      .join("\n");

    const workerSpawnCommands = targetItems
      .map((item) => {
        const workerTerminalId = `${idPrefix}-${item.index}`;
        const parentSection = [
          "## Communication",
          "",
          `Your parent coordinator is at terminal \`${parentTerminalId}\`.`,
          "When you complete your task, report back:",
          "```bash",
          `node bin/octogent channel send ${parentTerminalId} "DONE: ${item.text}" --from ${workerTerminalId}`,
          "```",
          "If you are blocked, ask for help:",
          "```bash",
          `node bin/octogent channel send ${parentTerminalId} "BLOCKED: <describe what you need>" --from ${workerTerminalId}`,
          "```",
          "",
          "## Next Item From The Swarm Queue",
          "",
          "This swarm has a shared queue of todo items that did not get their own worker. After reporting DONE, claim the next one instead of stopping:",
          "```bash",
          `node bin/octogent swarm claim ${tentacleId} --from ${workerTerminalId}`,
          "```",
          "- If it prints `CLAIMED #<index>: <text>`, that item is now yours alone. Treat it exactly like your first assignment (same scope rules, tests, and workspace rules; in worktree mode keep committing on your same branch), report DONE for it, then claim again.",
          "- If it prints `QUEUE EMPTY`, you are finished. Send one final message and stop:",
          "```bash",
          `node bin/octogent channel send ${parentTerminalId} "FINISHED" --from ${workerTerminalId}`,
          "```",
          "",
          "## Checkpoints",
          "",
          "If you get a BUDGET WARNING message, stop starting new work: finish the step you are on, commit it in worktree mode, and record where you are so the work is not lost if you are stopped:",
          "```bash",
          `node bin/octogent channel send ${parentTerminalId} "PROGRESS: <what is done, what is left, which files>" --from ${workerTerminalId}`,
          "```",
          buildEarlierProgressSection(item.index),
        ].join("\n");

        const promptVariables = JSON.stringify({
          tentacleName,
          tentacleId,
          tentacleContextPath,
          todoItemText: item.text,
          terminalId: workerTerminalId,
          apiPort,
          workspaceContextIntro: buildWorkerContextIntro(),
          workspaceGuidelines: buildWorkerGuidelines(workerTerminalId),
          commitGuidance: buildWorkerCommitGuidance(),
          definitionOfDoneCommitStep: buildWorkerDefinitionOfDoneCommitStep(),
          workspaceReminder: buildWorkerReminder(),
          parentTerminalId,
          parentSection,
        });

        const commandParts = [
          "node bin/octogent terminal create",
          `--terminal-id ${shellSingleQuote(workerTerminalId)}`,
          `--tentacle-id ${shellSingleQuote(tentacleId)}`,
          `--parent-terminal-id ${shellSingleQuote(parentTerminalId)}`,
          `--workspace-mode ${workerWorkspaceMode}`,
          `--name ${shellSingleQuote(tentacleName)}`,
          "--name-origin generated",
          `--auto-rename-prompt-context ${shellSingleQuote(item.text)}`,
          "--prompt-template swarm-worker",
          `--prompt-variables ${shellSingleQuote(promptVariables)}`,
          ...(workerModel ? [`--model ${shellSingleQuote(workerModel)}`] : []),
        ];
        if (workerWorkspaceMode === "worktree") {
          commandParts.splice(3, 0, `--worktree-id ${shellSingleQuote(workerTerminalId)}`);
        }
        const command = commandParts.join(" ");

        return `- \`${workerTerminalId}\`:\n  \`\`\`bash\n  ${command}\n  \`\`\``;
      })
      .join("\n");

    const parentBaseBranch =
      workerWorkspaceMode === "worktree" ? (baseRef === "HEAD" ? "main" : baseRef) : "main";

    const parentPrompt = await resolvePrompt(promptsDir, "swarm-parent", {
      tentacleName,
      tentacleId,
      workerCount: String(workers.length),
      maxChildrenPerParent: String(MAX_CHILDREN_PER_PARENT),
      workerListing,
      workerWorkspaceSection: buildWorkerWorkspaceSection(),
      workerSpawnCommands,
      queueSection: buildQueueSection(),
      budgetSection: budgetSection ?? "",
      completionStrategySection: buildCompletionStrategySection(parentBaseBranch),
      baseBranch: parentBaseBranch,
      terminalId: parentTerminalId,
      apiPort,
    });

    runtime.createTerminal({
      terminalId: parentTerminalId,
      tentacleId,
      tentacleName: `${tentacleName} (coordinator)`,
      workspaceMode: "shared",
      ...(agentProvider ? { agentProvider: agentProvider } : {}),
      ...(coordinatorModel ? { model: coordinatorModel } : {}),
      ...(parentPrompt ? { initialPrompt: parentPrompt } : {}),
    });

    swarmQueues.open(
      tentacleId,
      workers.map((w) => w.terminalId),
      queuedItems,
    );
  }

  return {
    tentacleId,
    parentTerminalId,
    workers,
    queuedItems,
    terminalIds: [
      ...(parentTerminalId ? [parentTerminalId] : []),
      ...workers.map((w) => w.terminalId),
    ],
  };
};
