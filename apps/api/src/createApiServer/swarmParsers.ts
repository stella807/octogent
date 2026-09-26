export type SwarmBudgetRequest = {
  budgetTokens: number;
  maxAttempts: number;
};

// Below this a coordinator cannot even read its own prompt; above the upper
// cap a typo (an extra zero or three) would make the budget meaningless.
const MIN_BUDGET_TOKENS = 1_000;
const MAX_BUDGET_TOKENS = 1_000_000_000;
const MAX_ATTEMPTS = 3;

/**
 * Reads `budgetTokens` and `maxAttempts` from a swarm request. Retries are
 * capped because every attempt spends its full budget: an uncapped retry loop
 * on a task that does not fit the budget would spend without end.
 */
export const parseSwarmBudget = (
  body: Record<string, unknown>,
): { budget: SwarmBudgetRequest | null; error: string | null } => {
  const { budgetTokens, maxAttempts } = body;
  if (budgetTokens === undefined) {
    if (maxAttempts !== undefined) {
      return { budget: null, error: "maxAttempts only applies together with budgetTokens." };
    }
    return { budget: null, error: null };
  }
  if (
    typeof budgetTokens !== "number" ||
    !Number.isInteger(budgetTokens) ||
    budgetTokens < MIN_BUDGET_TOKENS ||
    budgetTokens > MAX_BUDGET_TOKENS
  ) {
    return {
      budget: null,
      error: `budgetTokens must be a whole number of tokens between ${MIN_BUDGET_TOKENS} and ${MAX_BUDGET_TOKENS}.`,
    };
  }
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== "number" ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > MAX_ATTEMPTS)
  ) {
    return {
      budget: null,
      error: `maxAttempts must be 1 (no retry) up to ${MAX_ATTEMPTS}.`,
    };
  }
  return {
    budget: { budgetTokens, maxAttempts: (maxAttempts as number | undefined) ?? 1 },
    error: null,
  };
};
