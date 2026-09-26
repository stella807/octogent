import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";

import {
  ensureOctogentGitignoreEntry,
  ensureProjectScaffold,
  loadProjectConfig,
  loadProjectsRegistry,
  migrateStateToGlobal,
  registerProject,
  resolveEphemeralProjectStateDir,
  resolveProjectStateDir,
} from "./projectPersistence";
import { clearRuntimeMetadata, readRuntimeMetadata, writeRuntimeMetadata } from "./runtimeMetadata";
import {
  collectStartupPrerequisiteReport,
  formatStartupPrerequisiteReport,
} from "./startupPrerequisites";

const args = process.argv.slice(2);
const command = args[0];

const resolvePackageRoot = () => {
  const envRoot = process.env.OCTOGENT_PACKAGE_ROOT?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }

  const candidates = [
    resolve(import.meta.dirname ?? ".", "../.."),
    resolve(import.meta.dirname ?? ".", "../../.."),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return candidates[0] ?? process.cwd();
};

const PACKAGE_ROOT = resolvePackageRoot();

const resolveRuntimeAssetPath = (...relativePathCandidates: [string[], ...string[][]]) => {
  for (const relativePath of relativePathCandidates) {
    const candidate = join(PACKAGE_ROOT, ...relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return join(PACKAGE_ROOT, ...relativePathCandidates[0]);
};

const DEFAULT_START_PORT = 8787;
const MAX_PORT_ATTEMPTS = 200;

const initializeProject = (workspaceCwd: string, preferredName?: string) => {
  const projectName = preferredName?.trim() || basename(workspaceCwd) || "octogent-project";
  const hadConfig = loadProjectConfig(workspaceCwd) !== null;
  const projectConfig = ensureProjectScaffold(workspaceCwd, projectName);
  ensureOctogentGitignoreEntry(workspaceCwd);
  registerProject(workspaceCwd, projectConfig.displayName);
  const projectStateDir = resolveProjectStateDir(workspaceCwd, projectConfig.displayName);
  migrateStateToGlobal(workspaceCwd, projectStateDir);
  return {
    created: !hadConfig,
    projectConfig,
    projectStateDir,
  };
};

const resolveStartupProjectContext = (workspaceCwd: string) => {
  const existingConfig = loadProjectConfig(workspaceCwd);
  if (existingConfig) {
    registerProject(workspaceCwd, existingConfig.displayName);
    const projectStateDir = resolveProjectStateDir(workspaceCwd, existingConfig.displayName);
    migrateStateToGlobal(workspaceCwd, projectStateDir);
    return {
      isInitialized: true,
      projectDisplayName: existingConfig.displayName,
      projectStateDir,
    };
  }

  const projectDisplayName = basename(workspaceCwd) || "octogent-project";
  const projectStateDir = resolveEphemeralProjectStateDir(workspaceCwd);
  return {
    isInitialized: false,
    projectDisplayName,
    projectStateDir,
  };
};

const initProject = (name?: string) => {
  const projectPath = process.cwd();
  const { created, projectConfig, projectStateDir } = initializeProject(projectPath, name);

  console.log(
    `${created ? "Initialized" : "Updated"} Octogent project "${projectConfig.displayName}" at ${projectPath}`,
  );
  console.log("  .octogent/ directory ready (project metadata, tentacles, worktrees)");
  console.log(`  Global state: ${projectStateDir}`);
  console.log("  .gitignore updated");
  console.log("\nRun `octogent` to start the dashboard.");
};

const canListenOnPort = (port: number): Promise<boolean> =>
  new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, "127.0.0.1");
  });

const findOpenPort = async (startPort: number): Promise<number> => {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    if (await canListenOnPort(port)) {
      return port;
    }
  }

  throw new Error(`Unable to find an open port starting from ${startPort}`);
};

const readPreferredStartPort = () => {
  const rawPort = process.env.OCTOGENT_API_PORT ?? process.env.PORT;
  if (!rawPort) {
    return DEFAULT_START_PORT;
  }

  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_START_PORT;
  }

  return parsed;
};

const resolveRuntimeApiBase = () => {
  const explicitBase =
    process.env.OCTOGENT_API_ORIGIN?.trim() || process.env.OCTOGENT_API_BASE?.trim();
  if (explicitBase) {
    return explicitBase;
  }

  const projectConfig = loadProjectConfig(process.cwd());
  if (projectConfig) {
    const projectStateDir = resolveProjectStateDir(process.cwd(), projectConfig.displayName);
    const runtimeMetadata = readRuntimeMetadata(projectStateDir);
    if (runtimeMetadata) {
      return runtimeMetadata.apiBaseUrl;
    }
  }

  return `http://127.0.0.1:${readPreferredStartPort()}`;
};

const apiError = () => {
  console.error(
    `Error: Could not reach API at ${resolveRuntimeApiBase()}. Start Octogent in this project first.`,
  );
  process.exit(1);
};

const maybeOpenBrowser = (url: string) => {
  if (process.env.OCTOGENT_NO_OPEN === "1" || process.env.CI === "1") {
    return;
  }

  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // Best-effort browser open.
  }
};

const startServer = async () => {
  const startupPrerequisiteReport = collectStartupPrerequisiteReport();
  const startupPrerequisiteLines = formatStartupPrerequisiteReport(startupPrerequisiteReport);
  if (startupPrerequisiteLines.length > 0) {
    for (const line of startupPrerequisiteLines) {
      if (startupPrerequisiteReport.errors.length > 0) {
        console.error(line);
      } else {
        console.warn(line);
      }
    }
    if (startupPrerequisiteReport.errors.length > 0) {
      process.exit(1);
    }
    console.warn("");
  }

  const workspaceCwd = process.cwd();
  const { isInitialized, projectDisplayName, projectStateDir } =
    resolveStartupProjectContext(workspaceCwd);
  const promptsDir = resolveRuntimeAssetPath(["dist", "prompts"], ["prompts"]);
  const webDistDir = resolveRuntimeAssetPath(["dist", "web"], ["apps", "web", "dist"]);
  const port = await findOpenPort(readPreferredStartPort());
  const { createApiServer } = await import("./createApiServer");

  const apiServer = createApiServer({
    workspaceCwd,
    projectStateDir,
    promptsDir,
    webDistDir: existsSync(webDistDir) ? webDistDir : undefined,
    allowRemoteAccess: process.env.OCTOGENT_ALLOW_REMOTE_ACCESS === "1",
  });

  const shutdown = async () => {
    clearRuntimeMetadata(projectStateDir);
    await apiServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const { host, port: activePort } = await apiServer.start(port, "127.0.0.1");
  const apiBaseUrl = `http://${host}:${activePort}`;
  writeRuntimeMetadata(projectStateDir, {
    apiBaseUrl,
    host,
    port: activePort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workspaceCwd,
  });

  const hasWebDist = existsSync(webDistDir);
  if (hasWebDist) {
    maybeOpenBrowser(apiBaseUrl);
  }

  console.log();
  console.log("  Octogent is running");
  console.log(`  Project: ${workspaceCwd}`);
  console.log(`  Name:    ${projectDisplayName}`);
  console.log(`  API:     ${apiBaseUrl}`);
  if (hasWebDist) {
    console.log(`  UI:      ${apiBaseUrl}`);
  } else {
    console.log("  UI:      bundled web assets are missing from this install");
  }
  if (!isInitialized) {
    console.log("  Setup:   workspace is not initialized yet; use the in-app setup flow");
  }
  console.log();
};

const COLORS = [
  "#ff6b2b",
  "#ff2d6b",
  "#00ffaa",
  "#bf5fff",
  "#00c8ff",
  "#ffee00",
  "#39ff14",
  "#ff4df0",
  "#00fff7",
  "#ff9500",
];
const ANIMATIONS = ["sway", "walk", "jog", "bounce", "float", "swim-up"];
const EXPRESSIONS = ["normal", "happy", "angry", "surprised"];
const ACCESSORIES = ["none", "none", "long", "mohawk", "side-sweep", "curly"];
const HAIR_COLORS = [
  "#4a2c0a",
  "#1a1a1a",
  "#c8a04a",
  "#e04020",
  "#f5f5f5",
  "#6b3fa0",
  "#2a6e3f",
  "#1e90ff",
];

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)] as T;

const randomAppearance = () => ({
  color: pick(COLORS),
  octopus: {
    animation: pick(ANIMATIONS),
    expression: pick(EXPRESSIONS),
    accessory: pick(ACCESSORIES),
    hairColor: pick(HAIR_COLORS),
  },
});

const parseFlag = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
};

const parseJsonFlag = (flag: string): Record<string, string> | undefined => {
  const raw = parseFlag(flag);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`Error: ${flag} must be a JSON object.`);
      process.exit(1);
    }

    const entries = Object.entries(parsed).filter(([, value]) => typeof value === "string");
    return Object.fromEntries(entries);
  } catch {
    console.error(`Error: ${flag} must be valid JSON.`);
    process.exit(1);
  }
};

const tentacleCreate = async () => {
  const name = args[2];
  if (!name || name.startsWith("-")) {
    console.error("Error: tentacle name is required.");
    process.exit(1);
  }

  const description = parseFlag("--description") ?? parseFlag("-d") ?? "";
  const { color, octopus } = randomAppearance();
  const apiBase = resolveRuntimeApiBase();

  try {
    const response = await fetch(`${apiBase}/api/deck/tentacles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, color, octopus }),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(`Created tentacle "${data.tentacleId}"`);
  } catch {
    apiError();
  }
};

const tentacleList = async () => {
  const apiBase = resolveRuntimeApiBase();

  try {
    const response = await fetch(`${apiBase}/api/deck/tentacles`);
    if (!response.ok) {
      console.error("Error: failed to fetch tentacles.");
      process.exit(1);
    }

    const tentacles = (await response.json()) as Array<Record<string, unknown>>;
    if (tentacles.length === 0) {
      console.log("No tentacles found.");
      return;
    }

    for (const tentacle of tentacles) {
      const description = tentacle.description ? ` — ${tentacle.description}` : "";
      console.log(`  ${tentacle.tentacleId}${description}`);
    }
  } catch {
    apiError();
  }
};

const terminalCreate = async () => {
  const name = parseFlag("--name") ?? parseFlag("-n");
  const initialPrompt = parseFlag("--initial-prompt") ?? parseFlag("-p");
  const workspaceMode = parseFlag("--workspace-mode") ?? parseFlag("-w") ?? "shared";
  const terminalId = parseFlag("--terminal-id");
  const tentacleId = parseFlag("--tentacle-id");
  const worktreeId = parseFlag("--worktree-id");
  const parentTerminalId = parseFlag("--parent-terminal-id");
  const nameOrigin = parseFlag("--name-origin");
  const autoRenamePromptContext = parseFlag("--auto-rename-prompt-context");
  const promptTemplate = parseFlag("--prompt-template");
  const promptVariables = parseJsonFlag("--prompt-variables");
  const model = parseFlag("--model");
  const apiBase = resolveRuntimeApiBase();

  const body: Record<string, unknown> = {};
  if (name) body.name = name;
  if (initialPrompt) body.initialPrompt = initialPrompt;
  if (workspaceMode) body.workspaceMode = workspaceMode;
  if (terminalId) body.terminalId = terminalId;
  if (tentacleId) body.tentacleId = tentacleId;
  if (worktreeId) body.worktreeId = worktreeId;
  if (parentTerminalId) body.parentTerminalId = parentTerminalId;
  if (nameOrigin) body.nameOrigin = nameOrigin;
  if (autoRenamePromptContext) body.autoRenamePromptContext = autoRenamePromptContext;
  if (promptTemplate) body.promptTemplate = promptTemplate;
  if (promptVariables) body.promptVariables = promptVariables;
  if (model) body.model = model;

  try {
    const response = await fetch(`${apiBase}/api/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(`Created terminal "${data.terminalId}"`);
  } catch {
    apiError();
  }
};

const terminalList = async () => {
  const apiBase = resolveRuntimeApiBase();

  try {
    const response = await fetch(`${apiBase}/api/terminal-snapshots`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      console.error("Error: failed to fetch terminals.");
      process.exit(1);
    }

    const terminals = (await response.json()) as Array<Record<string, unknown>>;
    if (terminals.length === 0) {
      console.log("No terminals found.");
      return;
    }

    for (const terminal of terminals) {
      const terminalId = String(terminal.terminalId ?? "");
      const name = String(terminal.tentacleName ?? terminal.label ?? terminalId);
      const lifecycle = String(terminal.lifecycleState ?? terminal.state ?? "unknown");
      const pid =
        typeof terminal.processId === "number" && Number.isFinite(terminal.processId)
          ? ` pid=${terminal.processId}`
          : "";
      const reason =
        typeof terminal.lifecycleReason === "string" ? ` reason=${terminal.lifecycleReason}` : "";
      console.log(`  ${terminalId}  ${lifecycle}${pid}${reason}  ${name}`);
    }
  } catch {
    apiError();
  }
};

const terminalAction = async (action: "stop" | "kill") => {
  const terminalId = args[2];
  if (!terminalId || terminalId.startsWith("-")) {
    console.error("Error: terminalId is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/terminals/${encodeURIComponent(terminalId)}/${action}`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
      },
    );
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(`${action === "kill" ? "Killed" : "Stopped"} terminal "${data.terminalId}"`);
  } catch {
    apiError();
  }
};

const terminalPrune = async () => {
  const apiBase = resolveRuntimeApiBase();

  try {
    const response = await fetch(`${apiBase}/api/terminals/prune`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const data = (await response.json()) as { prunedTerminalIds?: string[]; error?: unknown };
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }

    const prunedTerminalIds = data.prunedTerminalIds ?? [];
    if (prunedTerminalIds.length === 0) {
      console.log("No stale, stopped, or exited terminals to prune.");
      return;
    }
    console.log(`Pruned ${prunedTerminalIds.length} terminal(s): ${prunedTerminalIds.join(", ")}`);
  } catch {
    apiError();
  }
};

const channelSend = async () => {
  const terminalId = args[2];
  if (!terminalId || terminalId.startsWith("-")) {
    console.error("Error: target terminalId is required.");
    process.exit(1);
  }

  const fromTerminalId = parseFlag("--from") ?? process.env.OCTOGENT_SESSION_ID ?? "";
  const fromIndex = args.indexOf("--from");
  const message =
    fromIndex !== -1
      ? args
          .slice(3)
          .filter((_, index) => {
            const absoluteIndex = index + 3;
            return absoluteIndex !== fromIndex && absoluteIndex !== fromIndex + 1;
          })
          .join(" ")
          .trim()
      : args
          .slice(3)
          .filter((value) => !value.startsWith("--from"))
          .join(" ")
          .trim();

  if (!message) {
    console.error("Error: message content is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/channels/${encodeURIComponent(terminalId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromTerminalId, content: message }),
      },
    );
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(`Message sent (${data.messageId}) to ${terminalId}`);
  } catch {
    apiError();
  }
};

const channelList = async () => {
  const terminalId = args[2];
  if (!terminalId || terminalId.startsWith("-")) {
    console.error("Error: terminalId is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/channels/${encodeURIComponent(terminalId)}/messages`,
    );
    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }

    const messages = (data.messages ?? []) as Array<Record<string, unknown>>;
    if (messages.length === 0) {
      console.log(`No messages for ${terminalId}.`);
      return;
    }

    for (const message of messages) {
      const status = message.delivered ? "delivered" : "pending";
      console.log(
        `  [${message.messageId}] from=${message.fromTerminalId || "(unknown)"} status=${status}: ${message.content}`,
      );
    }
  } catch {
    apiError();
  }
};

const swarmClaim = async () => {
  const tentacleId = args[2];
  if (!tentacleId || tentacleId.startsWith("-")) {
    console.error("Error: tentacleId is required.");
    process.exit(1);
  }
  const terminalId = parseFlag("--from") ?? process.env.OCTOGENT_SESSION_ID ?? "";
  if (!terminalId) {
    console.error("Error: --from <workerTerminalId> is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/deck/tentacles/${encodeURIComponent(tentacleId)}/swarm/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalId }),
      },
    );
    const data = (await response.json()) as {
      item?: { todoIndex: number; todoText: string } | null;
      remaining?: number;
      notes?: string[];
      error?: unknown;
    };
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    // Workers act on this output, so the two outcomes use fixed prefixes.
    if (!data.item) {
      console.log("QUEUE EMPTY");
      return;
    }
    console.log(`CLAIMED #${data.item.todoIndex}: ${data.item.todoText}`);
    console.log(`(${data.remaining ?? 0} item(s) still queued)`);
    if (data.notes && data.notes.length > 0) {
      console.log("A previous worker left progress on this item. Continue from it:");
      for (const note of data.notes) console.log(`  - ${note}`);
    }
  } catch {
    apiError();
  }
};

const parseIntegerFlag = (flag: string): number | undefined => {
  const raw = parseFlag(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(value)) {
    console.error(`Error: ${flag} must be a whole number, got "${raw}".`);
    process.exit(1);
  }
  return value;
};

const swarmStart = async () => {
  const tentacleId = args[2];
  if (!tentacleId || tentacleId.startsWith("-")) {
    console.error("Error: tentacleId is required.");
    process.exit(1);
  }

  const body: Record<string, unknown> = {};
  const workspaceMode = parseFlag("--workspace-mode") ?? parseFlag("-w");
  const workerModel = parseFlag("--worker-model");
  const coordinatorModel = parseFlag("--coordinator-model");
  const budgetTokens = parseIntegerFlag("--budget");
  const maxAttempts = parseIntegerFlag("--max-attempts");
  if (workspaceMode) body.workspaceMode = workspaceMode;
  if (workerModel) body.workerModel = workerModel;
  if (coordinatorModel) body.coordinatorModel = coordinatorModel;
  if (budgetTokens !== undefined) body.budgetTokens = budgetTokens;
  if (maxAttempts !== undefined) body.maxAttempts = maxAttempts;
  if (args.includes("--resume")) body.resume = true;

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/deck/tentacles/${encodeURIComponent(tentacleId)}/swarm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = (await response.json()) as {
      parentTerminalId?: string | null;
      workers?: Array<{ terminalId: string }>;
      queuedItems?: unknown[];
      budget?: { budgetTokens: number; maxAttempts: number };
      error?: unknown;
    };
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    console.log(
      `Started swarm for ${tentacleId}: ${data.workers?.length ?? 0} worker(s), ${data.queuedItems?.length ?? 0} queued item(s).`,
    );
    if (data.parentTerminalId) console.log(`Coordinator: ${data.parentTerminalId}`);
    if (data.budget) {
      console.log(
        `Budget: ${data.budget.budgetTokens.toLocaleString("en-US")} tokens per attempt, up to ${data.budget.maxAttempts} attempt(s).`,
      );
    }
  } catch {
    apiError();
  }
};

const swarmBudget = async () => {
  const tentacleId = args[2];
  if (!tentacleId || tentacleId.startsWith("-")) {
    console.error("Error: tentacleId is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/deck/tentacles/${encodeURIComponent(tentacleId)}/swarm/budget`,
    );
    const data = (await response.json()) as {
      budgetTokens?: number;
      maxAttempts?: number;
      outcome?: string;
      totalSpentTokens?: number;
      attempts?: Array<{ attempt: number; spentTokens: number; status: string }>;
      error?: unknown;
    };
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
    console.log(
      `Outcome: ${data.outcome}  (budget ${fmt(data.budgetTokens)} tokens per attempt, max ${data.maxAttempts} attempt(s))`,
    );
    for (const attempt of data.attempts ?? []) {
      console.log(
        `  attempt ${attempt.attempt}: ${fmt(attempt.spentTokens)} tokens, ${attempt.status}`,
      );
    }
    console.log(`Total spent: ${fmt(data.totalSpentTokens)} tokens`);
  } catch {
    apiError();
  }
};

const swarmQueue = async () => {
  const tentacleId = args[2];
  if (!tentacleId || tentacleId.startsWith("-")) {
    console.error("Error: tentacleId is required.");
    process.exit(1);
  }

  const apiBase = resolveRuntimeApiBase();
  try {
    const response = await fetch(
      `${apiBase}/api/deck/tentacles/${encodeURIComponent(tentacleId)}/swarm/queue`,
    );
    const data = (await response.json()) as {
      pending?: Array<{ todoIndex: number; todoText: string }>;
      claimed?: Array<{ todoIndex: number; todoText: string; terminalId: string }>;
      error?: unknown;
    };
    if (!response.ok) {
      console.error(`Error: ${data.error ?? "Failed"}`);
      process.exit(1);
    }
    const pending = data.pending ?? [];
    const claimed = data.claimed ?? [];
    console.log(`Queued (${pending.length}):`);
    for (const item of pending) console.log(`  #${item.todoIndex}: ${item.todoText}`);
    console.log(`Claimed (${claimed.length}):`);
    for (const item of claimed) {
      console.log(`  #${item.todoIndex} -> ${item.terminalId}: ${item.todoText}`);
    }
  } catch {
    apiError();
  }
};

const main = async () => {
  if (!command || command === "start") {
    return startServer();
  }

  if (command === "init") {
    return initProject(args[1]);
  }

  if (command === "projects" || command === "project") {
    const projects = loadProjectsRegistry().projects;
    if (projects.length === 0) {
      console.log(
        "No projects registered yet. Run `octogent` or `octogent init` in a project directory.",
      );
      return;
    }

    for (const project of projects) {
      console.log(`  ${project.name}  ${project.id}  ${project.path}`);
    }
    return;
  }

  if (command === "tentacle" || command === "tentacles") {
    if (args[1] === "create") {
      return tentacleCreate();
    }
    if (args[1] === "list" || args[1] === "ls") {
      return tentacleList();
    }
  }

  if (command === "terminal" || command === "terminals") {
    if (args[1] === "create") {
      return terminalCreate();
    }
    if (args[1] === "list" || args[1] === "ls") {
      return terminalList();
    }
    if (args[1] === "stop") {
      return terminalAction("stop");
    }
    if (args[1] === "kill") {
      return terminalAction("kill");
    }
    if (args[1] === "prune") {
      return terminalPrune();
    }
  }

  if (command === "channel") {
    if (args[1] === "send") {
      return channelSend();
    }
    if (args[1] === "list" || args[1] === "ls") {
      return channelList();
    }
  }

  if (command === "swarm") {
    if (args[1] === "start") {
      return swarmStart();
    }
    if (args[1] === "budget") {
      return swarmBudget();
    }
    if (args[1] === "claim") {
      return swarmClaim();
    }
    if (args[1] === "queue") {
      return swarmQueue();
    }
  }

  console.log(`Usage:
  octogent                             Start the dashboard in the current project
  octogent init [project-name]         Initialize the current directory explicitly
  octogent projects                    List registered projects

  octogent tentacle create <name>      Create a tentacle (Octogent must be running)
  octogent tentacle list               List tentacles
  octogent terminal create [options]   Create a terminal
    --name, -n                         Terminal display name
    --workspace-mode, -w               shared | worktree
    --initial-prompt, -p               Raw initial prompt text
    --terminal-id                      Explicit terminal ID
    --tentacle-id                      Existing tentacle ID to attach to
    --worktree-id                      Explicit worktree ID
    --parent-terminal-id               Parent terminal ID for child terminals
    --prompt-template                  Prompt template name
    --prompt-variables                 JSON object of prompt template variables
    --model                            Agent model, e.g. haiku | sonnet | opus
  octogent terminal list               List terminal lifecycle state
  octogent terminal stop <id>          Stop a terminal session
  octogent terminal kill <id>          Kill a terminal session or recorded process
  octogent terminal prune              Remove stale, stopped, and exited terminal records
  octogent channel send <id> <msg>     Send a channel message
  octogent channel list <id>           List channel messages
  octogent swarm start <tentacleId>    Start a swarm over the tentacle's open todo items
    --workspace-mode, -w               shared | worktree (default worktree)
    --worker-model / --coordinator-model  Agent model per caste, e.g. haiku / opus
    --budget                           Token budget shared by the whole swarm, per attempt
    --max-attempts                     1-3; retries stop and relaunch unfinished items
    --resume                           Skip items the saved progress shows done; carry notes
  octogent swarm budget <tentacleId>   Show a swarm's token spend and budget outcome
  octogent swarm claim <tentacleId>    Claim the next queued swarm item (--from <workerId>)
  octogent swarm queue <tentacleId>    Show queued and claimed swarm items`);
  process.exit(1);
};

main();
