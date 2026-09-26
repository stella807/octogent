/**
 * Picks a cheaper model for simple swarm items.
 *
 * Deliberately conservative: an item only counts as simple when it names
 * small mechanical work and nothing risky, and everything unrecognized stays
 * on the standard model. Putting a hard item on a weak model costs more in
 * review and rework than the cheaper tokens save.
 */

export type SwarmModelTier = "simple" | "standard";

/** Worker model value that asks for per-item routing instead of one model. */
export const SWARM_AUTO_MODEL = "auto";

/** Claude Code `--model` aliases used for each tier when routing is automatic. */
export const SWARM_AUTO_TIER_MODELS: Readonly<Record<SwarmModelTier, string>> = {
  simple: "haiku",
  standard: "sonnet",
};

export type TodoComplexity = { tier: SwarmModelTier; reason: string };

const SIMPLE_TAG = /(^|\s)#simple\b/i;
const COMPLEX_TAG = /(^|\s)#complex\b/i;

// Long items tend to bundle several changes, whatever words they use.
const SIMPLE_MAX_WORDS = 16;

const RISKY_WORDS = [
  "refactor",
  "architecture",
  "redesign",
  "rewrite",
  "migrate",
  "migration",
  "schema",
  "security",
  "auth",
  "authentication",
  "permission",
  "encrypt",
  "performance",
  "optimize",
  "optimise",
  "concurrency",
  "race",
  "deadlock",
  "debug",
  "investigate",
  "flaky",
  "leak",
  "protocol",
  // New behavior, whatever part of the product it lands in.
  "implement",
  "feature",
  "support",
  "search",
  "integrate",
  "integration",
];

// Mechanical on their own: the word names the kind of change.
const MECHANICAL_WORDS = [
  "typo",
  "typos",
  "spelling",
  "misspelling",
  "rename",
  "reword",
  "wording",
  "format",
  "formatter",
  "formatting",
  "lint",
  "whitespace",
  "indentation",
  "bump",
  "docstring",
  "docstrings",
  "comment",
  "comments",
  "changelog",
  "unused",
];

// These only name where the work is ("the docs", "the README"). They count as
// simple only when the item opens with a verb that edits existing text.
const TEXT_AREA_WORDS = ["docs", "documentation", "readme", "guide", "copy", "tooltip", "label"];
const TEXT_EDIT_VERBS = [
  "update",
  "fix",
  "edit",
  "clarify",
  "correct",
  "proofread",
  "tweak",
  "polish",
  "document",
];

const wordsOf = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export const classifyTodoComplexity = (text: string): TodoComplexity => {
  if (COMPLEX_TAG.test(text)) return { tier: "standard", reason: "tagged #complex" };
  if (SIMPLE_TAG.test(text)) return { tier: "simple", reason: "tagged #simple" };

  const words = wordsOf(text);
  const risky = words.find((word) => RISKY_WORDS.includes(word));
  if (risky) return { tier: "standard", reason: `mentions "${risky}"` };

  const mechanical = words.find((word) => MECHANICAL_WORDS.includes(word));
  const textArea =
    TEXT_EDIT_VERBS.includes(words[0] ?? "") &&
    words.find((word) => TEXT_AREA_WORDS.includes(word));
  const simple = mechanical ?? (textArea || undefined);
  if (simple && words.length <= SIMPLE_MAX_WORDS) {
    return { tier: "simple", reason: `mentions "${simple}"` };
  }
  return { tier: "standard", reason: simple ? "too long to be sure" : "default" };
};

/** The model a worker on `todoText` should run, given the swarm's worker model setting. */
export const resolveSwarmWorkerModel = (
  workerModel: string | undefined,
  todoText: string,
): string | undefined =>
  workerModel === SWARM_AUTO_MODEL
    ? SWARM_AUTO_TIER_MODELS[classifyTodoComplexity(todoText).tier]
    : workerModel;
