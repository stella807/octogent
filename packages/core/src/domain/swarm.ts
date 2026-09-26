import type { TentacleWorkspaceMode } from "./terminal";

/** Body of `POST /api/deck/tentacles/:tentacleId/swarm`. Every field is optional. */
export type SwarmLaunchRequest = {
  workspaceMode?: TentacleWorkspaceMode;
  /** A model alias for every worker, or "auto" to route each item by complexity. */
  workerModel?: string;
  coordinatorModel?: string;
  /** Tokens the coordinator and all workers share, per attempt. */
  budgetTokens?: number;
  /** 1-3; only with budgetTokens. */
  maxAttempts?: number;
  /** Continue from the saved progress ledger. */
  resume?: boolean;
  todoItemIndices?: number[];
};

// Below the minimum a coordinator cannot even read its own prompt; the maximum
// catches a typo (an extra few zeros) that would make a budget meaningless.
export const SWARM_BUDGET_MIN_TOKENS = 1_000;
export const SWARM_BUDGET_MAX_TOKENS = 1_000_000_000;
/** Every attempt can spend its full budget, so retries are capped. */
export const SWARM_MAX_ATTEMPTS = 3;
