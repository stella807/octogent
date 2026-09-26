export type SwarmBudgetAttempt = {
  attempt: number;
  terminalIds: string[];
  tokensByTerminal: Record<string, number>;
  spentTokens: number;
  status: "running" | "exceeded";
  /** Set once the early warning has been sent for this attempt. */
  warned: boolean;
  startedAt: string;
  exceededAt?: string;
};

export type SwarmBudgetOutcome = "running" | "retrying" | "exhausted";

export type SwarmBudgetSnapshot = {
  tentacleId: string;
  budgetTokens: number;
  maxAttempts: number;
  outcome: SwarmBudgetOutcome;
  totalSpentTokens: number;
  attempts: SwarmBudgetAttempt[];
};

type SwarmBudget = Omit<SwarmBudgetSnapshot, "totalSpentTokens">;

/**
 * Shared token budgets for swarms. Every agent in a swarm attempt (coordinator
 * and workers) draws from one total, as if the swarm were a single agent.
 *
 * The store only counts and flags; stopping agents and launching a retry is
 * the enforcer's job, reached through `onExceeded`, which fires once per
 * attempt the moment its total reaches the budget.
 */
/** Share of the budget at which agents are told to checkpoint and wind down. */
export const SWARM_BUDGET_WARNING_RATIO = 0.8;

export const createSwarmBudgetStore = ({
  onExceeded,
  onWarning,
}: {
  onExceeded: (tentacleId: string, attempt: number) => void;
  onWarning?: (tentacleId: string, attempt: number) => void;
}) => {
  const budgets = new Map<string, SwarmBudget>();
  const tentacleByTerminal = new Map<string, string>();

  const currentAttempt = (budget: SwarmBudget) => budget.attempts[budget.attempts.length - 1];

  const forget = (tentacleId: string) => {
    for (const attempt of budgets.get(tentacleId)?.attempts ?? []) {
      for (const terminalId of attempt.terminalIds) tentacleByTerminal.delete(terminalId);
    }
    budgets.delete(tentacleId);
  };

  return {
    open(tentacleId: string, options: { budgetTokens: number; maxAttempts: number }) {
      forget(tentacleId);
      budgets.set(tentacleId, {
        tentacleId,
        budgetTokens: options.budgetTokens,
        maxAttempts: options.maxAttempts,
        outcome: "running",
        attempts: [],
      });
    },

    startAttempt(tentacleId: string, terminalIds: string[]): number | null {
      const budget = budgets.get(tentacleId);
      if (!budget) return null;
      const attempt = budget.attempts.length + 1;
      budget.attempts.push({
        attempt,
        terminalIds: [...terminalIds],
        tokensByTerminal: {},
        spentTokens: 0,
        status: "running",
        warned: false,
        startedAt: new Date().toISOString(),
      });
      budget.outcome = "running";
      for (const terminalId of terminalIds) tentacleByTerminal.set(terminalId, tentacleId);
      return attempt;
    },

    /** `totalTokens` is the terminal's running total so far, not a delta. */
    recordUsage(terminalId: string, totalTokens: number) {
      const tentacleId = tentacleByTerminal.get(terminalId);
      if (!tentacleId) return;
      const budget = budgets.get(tentacleId);
      if (!budget) return;

      // Agents keep writing briefly after being stopped; that spend is still
      // recorded on their own attempt, never on the retry that replaced them.
      const attempt = budget.attempts.find((a) => a.terminalIds.includes(terminalId));
      if (!attempt) return;
      attempt.tokensByTerminal[terminalId] = totalTokens;
      attempt.spentTokens = Object.values(attempt.tokensByTerminal).reduce((a, b) => a + b, 0);

      const isLive = attempt.status === "running" && attempt === currentAttempt(budget);
      if (
        isLive &&
        !attempt.warned &&
        attempt.spentTokens >= budget.budgetTokens * SWARM_BUDGET_WARNING_RATIO &&
        attempt.spentTokens < budget.budgetTokens
      ) {
        attempt.warned = true;
        onWarning?.(tentacleId, attempt.attempt);
      }
      if (isLive && attempt.spentTokens >= budget.budgetTokens) {
        attempt.status = "exceeded";
        attempt.exceededAt = new Date().toISOString();
        onExceeded(tentacleId, attempt.attempt);
      }
    },

    /**
     * Drops a tentacle's budget. A later swarm without a budget reuses attempt-1
     * terminal ids, and must not be stopped by the budget of the one before.
     */
    close(tentacleId: string) {
      forget(tentacleId);
    },

    tracks(terminalId: string): boolean {
      return tentacleByTerminal.has(terminalId);
    },

    canRetry(tentacleId: string): boolean {
      const budget = budgets.get(tentacleId);
      return budget !== undefined && budget.attempts.length < budget.maxAttempts;
    },

    setOutcome(tentacleId: string, outcome: SwarmBudgetOutcome) {
      const budget = budgets.get(tentacleId);
      if (budget) budget.outcome = outcome;
    },

    snapshot(tentacleId: string): SwarmBudgetSnapshot | null {
      const budget = budgets.get(tentacleId);
      if (!budget) return null;
      const attempts = budget.attempts.map((a) => ({
        ...a,
        terminalIds: [...a.terminalIds],
        tokensByTerminal: { ...a.tokensByTerminal },
      }));
      return {
        ...budget,
        attempts,
        totalSpentTokens: attempts.reduce((sum, a) => sum + a.spentTokens, 0),
      };
    },
  };
};

export type SwarmBudgetStore = ReturnType<typeof createSwarmBudgetStore>;
