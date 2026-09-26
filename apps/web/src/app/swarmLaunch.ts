import {
  SWARM_AUTO_MODEL,
  SWARM_BUDGET_MAX_TOKENS,
  SWARM_BUDGET_MIN_TOKENS,
  type SwarmLaunchRequest,
  type TentacleWorkspaceMode,
  classifyTodoComplexity,
  resolveSwarmWorkerModel,
} from "@octogent/core";

export type SwarmModelOption = { value: string; label: string };

/** "" means no --model flag: the agent CLI's own default. */
export const SWARM_WORKER_MODEL_OPTIONS: SwarmModelOption[] = [
  { value: SWARM_AUTO_MODEL, label: "Auto (Haiku for simple items)" },
  { value: "haiku", label: "Haiku (cheapest)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus (most capable, most expensive)" },
  { value: "", label: "Agent default" },
];

export const SWARM_COORDINATOR_MODEL_OPTIONS: SwarmModelOption[] = [
  { value: "", label: "Agent default" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus (best planning and review)" },
  { value: "haiku", label: "Haiku (cheapest, weakest reviewer)" },
];

export type SwarmLaunchForm = {
  workspaceMode: TentacleWorkspaceMode;
  workerModel: string;
  coordinatorModel: string;
  budgetEnabled: boolean;
  budgetInput: string;
  maxAttempts: number;
  resume: boolean;
};

export const createSwarmLaunchForm = (workspaceMode: TentacleWorkspaceMode): SwarmLaunchForm => ({
  workspaceMode,
  // Cheap models for simple items is the point of this dialog, so it is the default.
  workerModel: SWARM_AUTO_MODEL,
  coordinatorModel: "",
  budgetEnabled: false,
  budgetInput: "2M",
  maxAttempts: 1,
  resume: false,
});

const TOKEN_AMOUNT = /^(\d+(?:\.\d+)?)\s*([km])?$/i;
const SUFFIX_MULTIPLIER: Record<string, number> = { k: 1_000, m: 1_000_000 };

/** Reads "2000000", "2,000,000", "500k", or "1.5M" as a whole number of tokens. */
export const parseTokenAmount = (input: string): number | null => {
  const match = TOKEN_AMOUNT.exec(input.replace(/[,_]/g, "").trim());
  if (!match) return null;
  const [, digits = "", suffix] = match;
  // A fraction only makes sense with a unit ("1.5M"), not as a token count.
  if (!suffix && digits.includes(".")) return null;
  const tokens = Math.round(
    Number(digits) * (suffix ? (SUFFIX_MULTIPLIER[suffix.toLowerCase()] ?? 1) : 1),
  );
  return Number.isSafeInteger(tokens) ? tokens : null;
};

export const formatTokenAmount = (tokens: number) => tokens.toLocaleString("en-US");

export const buildSwarmLaunchRequest = (
  form: SwarmLaunchForm,
): { request: SwarmLaunchRequest; error: null } | { request: null; error: string } => {
  const request: SwarmLaunchRequest = { workspaceMode: form.workspaceMode };
  if (form.workerModel) request.workerModel = form.workerModel;
  if (form.coordinatorModel) request.coordinatorModel = form.coordinatorModel;
  if (form.resume) request.resume = true;

  if (form.budgetEnabled) {
    const tokens = parseTokenAmount(form.budgetInput);
    if (tokens === null) {
      return { request: null, error: 'Budget must be a token amount such as "2M" or "500k".' };
    }
    if (tokens < SWARM_BUDGET_MIN_TOKENS || tokens > SWARM_BUDGET_MAX_TOKENS) {
      return {
        request: null,
        error: `Budget must be between ${formatTokenAmount(SWARM_BUDGET_MIN_TOKENS)} and ${formatTokenAmount(SWARM_BUDGET_MAX_TOKENS)} tokens.`,
      };
    }
    request.budgetTokens = tokens;
    // Retries are only ever triggered by running out of budget.
    if (form.maxAttempts > 1) request.maxAttempts = form.maxAttempts;
  }
  return { request, error: null };
};

export type SwarmWorkerPreviewRow = {
  index: number;
  text: string;
  /** Model alias, or "default" for the agent CLI's own default. */
  model: string;
  reason?: string;
};

/** Which model each open todo item's worker will run under the chosen setting. */
export const previewSwarmWorkerModels = (
  todoItems: ReadonlyArray<{ text: string; done: boolean }>,
  workerModel: string,
): SwarmWorkerPreviewRow[] =>
  todoItems.flatMap((item, index) => {
    if (item.done) return [];
    const model = resolveSwarmWorkerModel(workerModel || undefined, item.text) ?? "default";
    return [
      {
        index,
        text: item.text,
        model,
        ...(workerModel === SWARM_AUTO_MODEL
          ? { reason: classifyTodoComplexity(item.text).reason }
          : {}),
      },
    ];
  });

/** The API's own explanation for a refused swarm, so the dialog can show it. */
export const readSwarmLaunchError = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error;
    }
  } catch {
    // Fall through to the status line.
  }
  return `Octogent refused to start the swarm (HTTP ${response.status}).`;
};
