import type { SwarmModelTier } from "@octogent/core";

export type SwarmQueueItem = {
  todoIndex: number;
  todoText: string;
  /** Set when the swarm routes models per item; absent means any worker may take it. */
  tier?: SwarmModelTier;
};

export type SwarmQueueClaim = SwarmQueueItem & {
  terminalId: string;
  claimedAt: string;
};

export type SwarmQueueSnapshot = {
  workerTerminalIds: string[];
  pending: SwarmQueueItem[];
  claimed: SwarmQueueClaim[];
};

export type SwarmClaimResult =
  | { ok: true; item: SwarmQueueItem | null; remaining: number }
  | { ok: false; error: "no-swarm" | "not-a-worker" };

type SwarmQueue = {
  workerTerminalIds: Set<string>;
  workerTiers: Record<string, SwarmModelTier>;
  pending: SwarmQueueItem[];
  claimed: SwarmQueueClaim[];
};

/**
 * Overflow todo items for swarms, pulled by the fixed worker pool.
 *
 * A swarm spawns at most MAX_CHILDREN_PER_PARENT workers; items beyond that
 * wait here and each worker claims the next one when it finishes, so the whole
 * backlog runs without spawning more sessions. Reusing a warm worker also
 * skips the cold start of a fresh agent re-reading the tentacle context.
 *
 * In-memory like channel messages: PTY sessions do not survive an API restart
 * either, so a persisted queue would outlive the workers meant to drain it.
 */
export const createSwarmQueueStore = () => {
  const queues = new Map<string, SwarmQueue>();

  return {
    open(
      tentacleId: string,
      workerTerminalIds: string[],
      items: SwarmQueueItem[],
      workerTiers: Record<string, SwarmModelTier> = {},
    ) {
      queues.set(tentacleId, {
        workerTerminalIds: new Set(workerTerminalIds),
        workerTiers: { ...workerTiers },
        pending: items.map((item) => ({ ...item })),
        claimed: [],
      });
    },

    claim(tentacleId: string, terminalId: string): SwarmClaimResult {
      const queue = queues.get(tentacleId);
      if (!queue) {
        return { ok: false, error: "no-swarm" };
      }
      if (!queue.workerTerminalIds.has(terminalId)) {
        return { ok: false, error: "not-a-worker" };
      }

      // Todo order is priority order, so claims take the first item this
      // worker may do. A worker on the cheap model never takes a standard
      // item; the launcher guarantees a standard worker exists to take those.
      const onlySimple = queue.workerTiers[terminalId] === "simple";
      const position = queue.pending.findIndex((i) => !onlySimple || i.tier !== "standard");
      if (position === -1) {
        return { ok: true, item: null, remaining: queue.pending.length };
      }
      const [item] = queue.pending.splice(position, 1) as [SwarmQueueItem];
      queue.claimed.push({ ...item, terminalId, claimedAt: new Date().toISOString() });
      return { ok: true, item: { ...item }, remaining: queue.pending.length };
    },

    snapshot(tentacleId: string): SwarmQueueSnapshot | null {
      const queue = queues.get(tentacleId);
      if (!queue) {
        return null;
      }
      return {
        workerTerminalIds: [...queue.workerTerminalIds],
        pending: queue.pending.map((item) => ({ ...item })),
        claimed: queue.claimed.map((claim) => ({ ...claim })),
      };
    },
  };
};

export type SwarmQueueStore = ReturnType<typeof createSwarmQueueStore>;
