export type AgentRuntimeState =
  | "idle"
  | "processing"
  | "waiting_for_permission"
  | "waiting_for_user";

export const isAgentRuntimeState = (value: unknown): value is AgentRuntimeState =>
  value === "idle" ||
  value === "processing" ||
  value === "waiting_for_permission" ||
  value === "waiting_for_user";

export type TerminalAgentProvider = "codex" | "claude-code";

export const TERMINAL_AGENT_PROVIDERS: TerminalAgentProvider[] = ["codex", "claude-code"];

export const isTerminalAgentProvider = (value: unknown): value is TerminalAgentProvider =>
  typeof value === "string" && TERMINAL_AGENT_PROVIDERS.includes(value as TerminalAgentProvider);

// The model name is appended to the agent CLI command typed into a PTY shell,
// so only characters that real model ids use are allowed: no spaces, quotes,
// `$`, `;`, brackets, or anything else a shell would interpret.
const TERMINAL_AGENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export const isTerminalAgentModel = (value: unknown): value is string =>
  typeof value === "string" && TERMINAL_AGENT_MODEL_PATTERN.test(value);
