import { isTerminalAgentModel } from "@octogent/core";

import {
  type TentacleWorkspaceMode,
  type TerminalAgentProvider,
  type TerminalNameOrigin,
  isTerminalAgentProvider,
} from "../terminalRuntime";

const isTerminalNameOrigin = (value: unknown): value is TerminalNameOrigin =>
  value === "generated" || value === "user" || value === "prompt";

export const parseTerminalName = (payload: unknown) => {
  if (payload === null || payload === undefined) {
    return {
      provided: false,
      name: undefined as string | undefined,
      error: null as string | null,
    };
  }

  if (typeof payload !== "object") {
    return {
      provided: true,
      name: undefined as string | undefined,
      error: "Expected a JSON object body.",
    };
  }

  const rawName = (payload as Record<string, unknown>).name;
  if (rawName === undefined) {
    return {
      provided: false,
      name: undefined as string | undefined,
      error: null as string | null,
    };
  }

  if (typeof rawName !== "string") {
    return {
      provided: true,
      name: undefined as string | undefined,
      error: "Terminal name must be a string.",
    };
  }

  const trimmed = rawName.trim();
  if (trimmed.length === 0) {
    return {
      provided: true,
      name: undefined as string | undefined,
      error: "Terminal name cannot be empty.",
    };
  }

  return {
    provided: true,
    name: trimmed,
    error: null as string | null,
  };
};

export const parseTerminalWorkspaceMode = (payload: unknown) => {
  if (payload === null || payload === undefined) {
    return {
      workspaceMode: "shared" as TentacleWorkspaceMode,
      error: null as string | null,
    };
  }

  if (typeof payload !== "object") {
    return {
      workspaceMode: "shared" as TentacleWorkspaceMode,
      error: "Expected a JSON object body.",
    };
  }

  const rawWorkspaceMode = (payload as Record<string, unknown>).workspaceMode;
  if (rawWorkspaceMode === undefined) {
    return {
      workspaceMode: "shared" as TentacleWorkspaceMode,
      error: null as string | null,
    };
  }

  if (rawWorkspaceMode !== "shared" && rawWorkspaceMode !== "worktree") {
    return {
      workspaceMode: "shared" as TentacleWorkspaceMode,
      error: "Terminal workspace mode must be either 'shared' or 'worktree'.",
    };
  }

  return {
    workspaceMode: rawWorkspaceMode as TentacleWorkspaceMode,
    error: null as string | null,
  };
};

export const parseTerminalAgentProvider = (payload: unknown) => {
  if (payload === null || payload === undefined) {
    return {
      agentProvider: undefined as TerminalAgentProvider | undefined,
      error: null as string | null,
    };
  }

  if (typeof payload !== "object") {
    return {
      agentProvider: undefined as TerminalAgentProvider | undefined,
      error: "Expected a JSON object body.",
    };
  }

  const rawAgentProvider = (payload as Record<string, unknown>).agentProvider;
  if (rawAgentProvider === undefined) {
    return {
      agentProvider: undefined as TerminalAgentProvider | undefined,
      error: null as string | null,
    };
  }

  if (!isTerminalAgentProvider(rawAgentProvider)) {
    return {
      agentProvider: undefined as TerminalAgentProvider | undefined,
      error: "Terminal agent provider must be either 'codex' or 'claude-code'.",
    };
  }

  return {
    agentProvider: rawAgentProvider,
    error: null as string | null,
  };
};

export const parseTerminalNameOrigin = (payload: unknown) => {
  if (payload === null || payload === undefined) {
    return {
      nameOrigin: undefined as TerminalNameOrigin | undefined,
      error: null as string | null,
    };
  }

  if (typeof payload !== "object") {
    return {
      nameOrigin: undefined as TerminalNameOrigin | undefined,
      error: "Expected a JSON object body.",
    };
  }

  const rawNameOrigin = (payload as Record<string, unknown>).nameOrigin;
  if (rawNameOrigin === undefined) {
    return {
      nameOrigin: undefined as TerminalNameOrigin | undefined,
      error: null as string | null,
    };
  }

  if (!isTerminalNameOrigin(rawNameOrigin)) {
    return {
      nameOrigin: undefined as TerminalNameOrigin | undefined,
      error: "Terminal name origin must be 'generated', 'user', or 'prompt'.",
    };
  }

  return {
    nameOrigin: rawNameOrigin,
    error: null as string | null,
  };
};

/**
 * Reads an optional agent model from `payload[key]`. Rejecting rather than
 * sanitizing: the value ends up in a shell command, and a silently rewritten
 * model name would run a different model than the caller asked for.
 */
export const parseTerminalAgentModel = (payload: unknown, key = "model") => {
  const raw =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)[key]
      : undefined;
  if (raw === undefined) {
    return { model: undefined as string | undefined, error: null as string | null };
  }
  if (!isTerminalAgentModel(raw)) {
    return {
      model: undefined as string | undefined,
      error: `${key} must be a model id such as "sonnet" or "claude-haiku-4-5" (letters, digits, ".", "_", ":", "-").`,
    };
  }
  return { model: raw, error: null as string | null };
};
