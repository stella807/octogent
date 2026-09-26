# Orchestrating Child Agents

Octogent uses child terminals to split work into parallel streams.

## How spawning works

A child agent is a normal terminal record with `parentTerminalId` set. The relationship is stored in the terminal registry and shown in the UI; the child still has its own terminal ID, lifecycle state, transcript, workspace mode, and optional worktree.

Deck creates child agents from todo items by resolving prompt templates. The prompt receives the tentacle name, tentacle ID, path to `.octogent/tentacles/<tentacle-id>/`, todo text, terminal ID, API port, workspace guidance, and parent terminal ID when a parent exists.

## When to use child agents

Use child agents when:

- tasks are independent enough to run in parallel
- the parent can define clean scopes
- each task fits one tentacle or one todo item
- the expected file overlap is low or worktree mode is available

Do not use them when the work is too entangled and the agents will overwrite each other.

## Recommended workflow

1. create or pick a tentacle
2. write or refine `CONTEXT.md`
3. break the work into checkbox items in `todo.md`
4. spawn worker terminals from those items
5. review results in the parent terminal
6. use channel messages when workers need to coordinate
7. update `todo.md` only after reviewing the result

## Shared vs worktree

Use `shared` when:

- the tasks are read-heavy
- the changes are small
- you want fast setup

Use `worktree` when:

- the tasks touch overlapping files
- you want clean git isolation
- you expect larger code edits

In shared mode, workers all run in the main workspace and are told not to commit. This is faster but relies on careful scoping and review.

In worktree mode, each worker gets a branch named `octogent/<worker-terminal-id>` under `.octogent/worktrees/<worker-terminal-id>/` and is told to commit its work. The parent coordinator is responsible for merging branches, running tests, and updating tentacle state.

## Parent coordinator behavior

When a swarm has more than one target item, Octogent creates a parent terminal like `<tentacle-id>-swarm-parent`. The parent prompt contains:

- the list of worker terminal IDs and assigned todo indices
- commands for creating each worker terminal
- communication instructions for `octogent channel send`
- a completion strategy for shared mode or worktree mode
- the final requirement to review, test, and update tentacle docs/todos

The parent is intentionally not a magic scheduler. It is an agent session with explicit instructions and a visible terminal. That makes orchestration inspectable and interruptible.

## Token budgets

A swarm can be given one token budget that its coordinator and every worker draw from together:

```bash
octogent swarm start <tentacle-id> --budget 2000000 --max-attempts 2
```

Octogent reads each agent's Claude Code transcript on every tool call and turn end, and adds up input, output, and cache tokens the same way the usage chart does. When the shared total reaches the budget:

1. every agent in that attempt is stopped at once, finished or not. Agents are stopped, not deleted, so worktree branches and their commits stay intact.
2. if attempts remain and some items were not reported DONE, a fresh attempt starts on only those items, with a new coordinator, new workers (terminal IDs like `<tentacle-id>-swarm-a2-<index>`), and a fresh budget of the same size. The new coordinator is told what the last attempt spent, which items it finished, and which of its worker branches to merge.
3. otherwise the swarm stops for good.

At 80% of the budget, Octogent first sends every agent in the attempt a `BUDGET WARNING` channel message: workers finish their current step, commit it in worktree mode, and send a `PROGRESS:` note to the coordinator, so a stop that follows loses as little as possible.

Every stop is recorded in `.octogent/tentacles/<tentacle-id>/swarm-budget.md` with the spend per agent, what finished, what did not, and what to change. `octogent swarm budget <tentacle-id>` shows the same numbers.

Things to know before relying on it:

- **Retries cost money too.** The worst case is `budget x max-attempts`. Retries are capped at 3 attempts so a task that cannot fit its budget never loops forever.
- **Tokens spent before a stop are still spent.** A budget caps the loss; it does not refund it.
- **Enforcement lags by one tool call.** Usage is checked when an agent calls a tool or ends a turn, so the final total can overshoot by that last step.
- **Claude Code only.** Codex terminals send no hooks, so swarms using Codex cannot take a budget.
- **Subagents may be undercounted.** Octogent reads the transcript file each hook names. Claude Code versions that write subagent usage to separate files will have that usage missed, so keep a margin in the budget if workers use subagents.
- **Budgets live in memory**, like channels and the swarm queue, and do not survive an API restart. Progress does: see below.

## Remembered progress

Octogent keeps a progress ledger for every swarm, budgeted or not, built from signals agents already send, so it costs no tokens:

- queue claims record which worker holds which item
- `DONE: <item>` messages to the coordinator mark the item done
- `PROGRESS: <note>` messages to the coordinator are filed under the sender's current item

The ledger is written to `swarms/<tentacle-id>.json` in the project state directory (see [Filesystem Layout](../reference/filesystem-layout.md)) (atomically, so a crash cannot truncate it) and rendered as `.octogent/tentacles/<tentacle-id>/swarm-progress.md`. It is what budget retries use: a retry skips items reported done, and each retry worker is handed the notes its item's previous worker left, so it continues instead of starting over. A worker that claims a queued item gets that item's notes too.

Because it is on disk, it also survives an API restart, which ends every agent session. To pick up where a swarm left off, remove its old terminals and start it again with `--resume`:

```bash
octogent swarm start <tentacle-id> --resume
```

Resume skips open todo items whose text matches an item the ledger shows done, and carries the notes for the rest. "Done" means a worker reported it; it has not necessarily been reviewed or merged, so check `swarm-progress.md` before resuming. Starting a swarm without `--resume` begins a fresh ledger.

## Worker limits and identity

Each parent can have up to 9 child terminals. If a swarm has more incomplete todo items than that, the first 9 in todo order each get a worker and the rest go into the swarm queue. After a worker reports DONE, it runs `octogent swarm claim` and takes the next queued item in its same session (and, in worktree mode, on its same branch). When the queue is empty it reports FINISHED, and the coordinator merges once every worker has.

The pool is fixed on purpose. Spawning a fresh agent per item pays a cold start each time, with the new session re-reading the tentacle context and codebase. A warm worker already has that context, so a long backlog costs fewer tokens run through 9 workers than through one new worker per item.

## Worker models

Spawn Swarm (from a tentacle's panel or its right-click menu) opens a settings dialog before anything starts. It sets the workspace mode, the worker and coordinator models, an optional token budget with retries, and whether to continue from saved progress. The same options exist on `octogent swarm start` and the swarm API.

The worker model defaults to **Auto**, which picks a model per todo item so simple work runs on a cheaper model:

- **Simple items run on Haiku.** An item is simple when it names small mechanical work (a typo, rename, docs or comment change, formatting, lint, a version bump), is short, and mentions nothing risky.
- **Everything else runs on Sonnet**, including anything that mentions refactoring, migration, schemas, security or auth, performance, concurrency, debugging, or flaky tests, and anything the rules do not recognize.
- **Tags override the rules.** Add `#simple` or `#complex` to a todo item's text.

The dialog previews which model each open item will get, and hovering a row shows why. The rules are deliberately cautious: a hard item on a weak model costs more in coordinator review and rework than the cheaper tokens save, so only clearly simple items are downgraded.

Auto routing carries through the queue. A Haiku worker only claims simple items, and when standard items are queued the pool always includes a Sonnet worker to take them; if none of the first items needed one, the last worker is promoted.

You can instead run every worker on one model (Haiku, Sonnet, Opus, or the agent's default). The coordinator model is separate: it plans and reviews every worker's output, so a stronger model there usually pays for itself.

## Token budgets

A swarm can be given one token budget that its coordinator and every worker draw from together:

```bash
octogent swarm start <tentacle-id> --budget 2000000 --max-attempts 2
```

Octogent reads each agent's Claude Code transcript on every tool call and turn end, and adds up input, output, and cache tokens the same way the usage chart does. When the shared total reaches the budget:

1. every agent in that attempt is stopped at once, finished or not. Agents are stopped, not deleted, so worktree branches and their commits stay intact.
2. if attempts remain and some items were not reported DONE, a fresh attempt starts on only those items, with a new coordinator, new workers (terminal IDs like `<tentacle-id>-swarm-a2-<index>`), and a fresh budget of the same size. The new coordinator is told what the last attempt spent, which items it finished, and which of its worker branches to merge.
3. otherwise the swarm stops for good.

At 80% of the budget, Octogent first sends every agent in the attempt a `BUDGET WARNING` channel message: workers finish their current step, commit it in worktree mode, and send a `PROGRESS:` note to the coordinator, so a stop that follows loses as little as possible.

Every stop is recorded in `.octogent/tentacles/<tentacle-id>/swarm-budget.md` with the spend per agent, what finished, what did not, and what to change. `octogent swarm budget <tentacle-id>` shows the same numbers.

Things to know before relying on it:

- **Retries cost money too.** The worst case is `budget x max-attempts`. Retries are capped at 3 attempts so a task that cannot fit its budget never loops forever.
- **Tokens spent before a stop are still spent.** A budget caps the loss; it does not refund it.
- **Enforcement lags by one tool call.** Usage is checked when an agent calls a tool or ends a turn, so the final total can overshoot by that last step.
- **Claude Code only.** Codex terminals send no hooks, so swarms using Codex cannot take a budget.
- **Subagents may be undercounted.** Octogent reads the transcript file each hook names. Claude Code versions that write subagent usage to separate files will have that usage missed, so keep a margin in the budget if workers use subagents.
- **Budgets live in memory**, like channels and the swarm queue, and do not survive an API restart. Progress does: see below.

## Remembered progress

Octogent keeps a progress ledger for every swarm, budgeted or not, built from signals agents already send, so it costs no tokens:

- queue claims record which worker holds which item
- `DONE: <item>` messages to the coordinator mark the item done
- `PROGRESS: <note>` messages to the coordinator are filed under the sender's current item

The ledger is written to `swarms/<tentacle-id>.json` in the project state directory (see [Filesystem Layout](../reference/filesystem-layout.md)) (atomically, so a crash cannot truncate it) and rendered as `.octogent/tentacles/<tentacle-id>/swarm-progress.md`. It is what budget retries use: a retry skips items reported done, and each retry worker is handed the notes its item's previous worker left, so it continues instead of starting over. A worker that claims a queued item gets that item's notes too.

Because it is on disk, it also survives an API restart, which ends every agent session. To pick up where a swarm left off, remove its old terminals and start it again with `--resume`:

```bash
octogent swarm start <tentacle-id> --resume
```

Resume skips open todo items whose text matches an item the ledger shows done, and carries the notes for the rest. "Done" means a worker reported it; it has not necessarily been reviewed or merged, so check `swarm-progress.md` before resuming. Starting a swarm without `--resume` begins a fresh ledger.

## Worker limits and identity

Each parent can have up to 9 child terminals. If a swarm has more incomplete todo items than that, the first 9 in todo order each get a worker and the rest go into the swarm queue. After a worker reports DONE, it runs `octogent swarm claim` and takes the next queued item in its same session (and, in worktree mode, on its same branch). When the queue is empty it reports FINISHED, and the coordinator merges once every worker has.

The pool is fixed on purpose. Spawning a fresh agent per item pays a cold start each time, with the new session re-reading the tentacle context and codebase. A warm worker already has that context, so a long backlog costs fewer tokens run through 9 workers than through one new worker per item.

## Worker models

A swarm request can set `coordinatorModel` and `workerModel`, for example `opus` for the coordinator that plans and reviews merges, and `haiku` or `sonnet` for workers doing narrow, well-scoped items. Both are optional; unset means the agent CLI's default model. This is where swarms save the most credits, because workers produce most of the tokens. Use a cheaper worker model only when todo items are small and clearly specified, since a weaker worker on a vague item costs more in coordinator review and rework than it saves.

Worker terminal IDs are derived from the tentacle ID and todo index. That makes duplicate detection simple: Octogent refuses to start a second active solve or swarm for the same item pattern.

## Limits

- PTY sessions do not survive API restarts
- channel messages are in-memory only
- delegation quality depends on the quality of `CONTEXT.md` and `todo.md`
- shared-mode workers can still collide in files, because shared mode is not git isolation
- worktree-mode workers still need a human or parent merge step before their work reaches the base branch
