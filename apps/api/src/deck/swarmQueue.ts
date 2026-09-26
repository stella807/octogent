export type SwarmQueueItem = {
  todoIndex: number;
  todoText: string;
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
    open(tentacleId: string, workerTerminalIds: string[], items: SwarmQueueItem[]) {
      queues.set(tentacleId, {
        workerTerminalIds: new Set(workerTerminalIds),
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

      // Todo order is priority order, so claims always take the head.
      const item = queue.pending.shift();
      if (!item) {
        return { ok: true, item: null, remaining: 0 };
      }
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
