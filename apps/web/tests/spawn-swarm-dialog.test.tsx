import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpawnSwarmDialog } from "../src/components/canvas/SpawnSwarmDialog";

const todoItems = [
  { text: "Fix typo in README", done: false },
  { text: "Refactor the session runtime", done: false },
  { text: "Shipped already", done: true },
];

const renderDialog = (onLaunch = vi.fn().mockResolvedValue({ ok: true })) => {
  const onCancel = vi.fn();
  render(
    <SpawnSwarmDialog
      tentacleName="Docs & Knowledge"
      initialWorkspaceMode="worktree"
      todoItems={todoItems}
      onCancel={onCancel}
      onLaunch={onLaunch}
    />,
  );
  return { onLaunch, onCancel };
};

describe("SpawnSwarmDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("previews the cheap model for simple items and the standard one for the rest", () => {
    renderDialog();
    const preview = screen.getByRole("list", { name: "Worker model per item" });
    const rows = within(preview).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Fix typo in README");
    expect(rows[0]).toHaveTextContent("haiku");
    expect(rows[1]).toHaveTextContent("Refactor the session runtime");
    expect(rows[1]).toHaveTextContent("sonnet");
  });

  it("updates the preview when a single model is chosen for every worker", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Worker model"), { target: { value: "opus" } });
    const rows = within(screen.getByRole("list", { name: "Worker model per item" })).getAllByRole(
      "listitem",
    );
    for (const row of rows) expect(row).toHaveTextContent("opus");
  });

  it("launches with auto routing and no budget by default", async () => {
    const { onLaunch } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Spawn swarm" }));
    await waitFor(() => {
      expect(onLaunch).toHaveBeenCalledWith({ workspaceMode: "worktree", workerModel: "auto" });
    });
  });

  it("sends a budget with retries and shows the worst-case spend", async () => {
    const { onLaunch } = renderDialog();
    fireEvent.click(screen.getByLabelText("Limit token spend"));
    fireEvent.change(screen.getByLabelText("Token budget per attempt"), {
      target: { value: "2M" },
    });
    fireEvent.change(screen.getByLabelText("Attempts"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Coordinator model"), { target: { value: "opus" } });

    expect(screen.getByText(/worst case: 4,000,000 tokens/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Spawn swarm" }));

    await waitFor(() => {
      expect(onLaunch).toHaveBeenCalledWith({
        workspaceMode: "worktree",
        workerModel: "auto",
        coordinatorModel: "opus",
        budgetTokens: 2_000_000,
        maxAttempts: 2,
      });
    });
  });

  it("blocks an unreadable budget instead of launching", () => {
    const { onLaunch } = renderDialog();
    fireEvent.click(screen.getByLabelText("Limit token spend"));
    fireEvent.change(screen.getByLabelText("Token budget per attempt"), {
      target: { value: "plenty" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/budget/i);
    expect(screen.getByRole("button", { name: "Spawn swarm" })).toBeDisabled();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the server's reason when launching fails", async () => {
    renderDialog(
      vi
        .fn()
        .mockResolvedValue({ ok: false, error: "A swarm is already active for this tentacle." }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Spawn swarm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already active");
    expect(screen.getByRole("button", { name: "Spawn swarm" })).toBeEnabled();
  });
});
