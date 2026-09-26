import {
  SWARM_MAX_ATTEMPTS,
  type SwarmLaunchRequest,
  type TentacleWorkspaceMode,
} from "@octogent/core";
import { useMemo, useState } from "react";

import {
  SWARM_COORDINATOR_MODEL_OPTIONS,
  SWARM_WORKER_MODEL_OPTIONS,
  buildSwarmLaunchRequest,
  createSwarmLaunchForm,
  formatTokenAmount,
  previewSwarmWorkerModels,
} from "../../app/swarmLaunch";
import { ActionButton } from "../ui/ActionButton";

export type SpawnSwarmResult = { ok: true } | { ok: false; error: string };

type SpawnSwarmDialogProps = {
  tentacleName: string;
  initialWorkspaceMode: TentacleWorkspaceMode;
  /** Null while the tentacle's todo list has not loaded. */
  todoItems: ReadonlyArray<{ text: string; done: boolean }> | null;
  onCancel: () => void;
  onLaunch: (request: SwarmLaunchRequest) => Promise<SpawnSwarmResult>;
};

const ATTEMPT_LABELS: Record<number, string> = {
  1: "1 (no retry)",
  2: "2 (retry once)",
  3: "3 (retry twice)",
};

export const SpawnSwarmDialog = ({
  tentacleName,
  initialWorkspaceMode,
  todoItems,
  onCancel,
  onLaunch,
}: SpawnSwarmDialogProps) => {
  const [form, setForm] = useState(() => createSwarmLaunchForm(initialWorkspaceMode));
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const built = useMemo(() => buildSwarmLaunchRequest(form), [form]);
  const preview = useMemo(
    () => (todoItems ? previewSwarmWorkerModels(todoItems, form.workerModel) : []),
    [todoItems, form.workerModel],
  );
  const error = built.error ?? launchError;
  const update = (patch: Partial<typeof form>) => {
    setLaunchError(null);
    setForm((current) => ({ ...current, ...patch }));
  };

  const handleLaunch = async () => {
    if (!built.request || isLaunching) return;
    setIsLaunching(true);
    try {
      const result = await onLaunch(built.request);
      if (!result.ok) setLaunchError(result.error);
    } finally {
      setIsLaunching(false);
    }
  };

  const budgetTokens = built.request?.budgetTokens;
  const attempts = built.request?.maxAttempts ?? 1;

  return (
    <section
      aria-label="Spawn swarm"
      className="swarm-dialog"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || isLaunching) return;
        event.preventDefault();
        onCancel();
      }}
      tabIndex={-1}
    >
      <header className="swarm-dialog-header">
        <h2>Spawn Swarm</h2>
        <span className="swarm-dialog-tentacle">{tentacleName}</span>
      </header>

      <div className="swarm-dialog-body">
        <label className="swarm-dialog-field">
          <span>Workspace</span>
          <select
            value={form.workspaceMode}
            onChange={(event) =>
              update({ workspaceMode: event.target.value as TentacleWorkspaceMode })
            }
          >
            <option value="worktree">Worktrees (isolated branches)</option>
            <option value="shared">Normal (shared workspace)</option>
          </select>
        </label>

        <label className="swarm-dialog-field">
          <span>Worker model</span>
          <select
            value={form.workerModel}
            onChange={(event) => update({ workerModel: event.target.value })}
          >
            {SWARM_WORKER_MODEL_OPTIONS.map((option) => (
              <option key={option.value || "default"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {preview.length > 0 && (
          <div className="swarm-dialog-preview">
            <ul aria-label="Worker model per item">
              {preview.map((row) => (
                <li key={row.index} title={row.reason ? `Why: ${row.reason}` : undefined}>
                  <span className={`swarm-dialog-model swarm-dialog-model--${row.model}`}>
                    {row.model}
                  </span>
                  <span className="swarm-dialog-item">{row.text}</span>
                </li>
              ))}
            </ul>
            {form.workerModel === "auto" && (
              <p className="swarm-dialog-hint">
                Only clearly simple items get the cheap model. Add #simple or #complex to a todo
                item to override.
              </p>
            )}
          </div>
        )}

        <label className="swarm-dialog-field">
          <span>Coordinator model</span>
          <select
            value={form.coordinatorModel}
            onChange={(event) => update({ coordinatorModel: event.target.value })}
          >
            {SWARM_COORDINATOR_MODEL_OPTIONS.map((option) => (
              <option key={option.value || "default"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="swarm-dialog-check">
          <input
            type="checkbox"
            checked={form.budgetEnabled}
            onChange={(event) => update({ budgetEnabled: event.target.checked })}
          />
          <span>Limit token spend</span>
        </label>

        {form.budgetEnabled && (
          <div className="swarm-dialog-budget">
            <label className="swarm-dialog-field">
              <span>Token budget per attempt</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="2M"
                value={form.budgetInput}
                onChange={(event) => update({ budgetInput: event.target.value })}
              />
            </label>
            <label className="swarm-dialog-field">
              <span>Attempts</span>
              <select
                value={form.maxAttempts}
                onChange={(event) => update({ maxAttempts: Number(event.target.value) })}
              >
                {Array.from({ length: SWARM_MAX_ATTEMPTS }, (_, i) => i + 1).map((count) => (
                  <option key={count} value={count}>
                    {ATTEMPT_LABELS[count] ?? count}
                  </option>
                ))}
              </select>
            </label>
            {budgetTokens !== undefined && (
              <p className="swarm-dialog-hint">
                The coordinator and every worker share this budget. At 80% they checkpoint; at 100%
                they all stop{attempts > 1 ? " and unfinished items restart" : ""}. Worst case:{" "}
                {formatTokenAmount(budgetTokens * attempts)} tokens.
              </p>
            )}
          </div>
        )}

        <label className="swarm-dialog-check">
          <input
            type="checkbox"
            checked={form.resume}
            onChange={(event) => update({ resume: event.target.checked })}
          />
          <span>Continue from saved progress</span>
        </label>

        {error && (
          <p className="swarm-dialog-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="swarm-dialog-actions">
        <ActionButton
          aria-label="Cancel"
          disabled={isLaunching}
          onClick={onCancel}
          size="dense"
          variant="accent"
        >
          Cancel
        </ActionButton>
        <ActionButton
          aria-label="Spawn swarm"
          disabled={isLaunching || built.request === null}
          onClick={() => void handleLaunch()}
          size="dense"
          variant="primary"
        >
          {isLaunching ? "Spawning…" : "Spawn swarm"}
        </ActionButton>
      </div>
    </section>
  );
};
