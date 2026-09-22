/**
 * Provenance analysis for a git history.
 *
 * The whole product rests on one observation: agentic coding tools already stamp their
 * work with `Co-Authored-By` trailers by default, and trailers survive rebase. That makes
 * authorship attribution a property of history the team already has, rather than something
 * that has to be instrumented after the fact.
 *
 * Pure functions only. The git adapter lives in `git.mjs` so this stays testable and so no
 * repository content ever has to leave the machine to produce a report.
 */

/** Vendor signatures matched against the identity in a co-author trailer. */
const AGENT_SIGNATURES = [
  {
    agent: "claude",
    pattern: /(noreply@anthropic\.com|\bclaude(\s|-)?(code|opus|sonnet|haiku)?\s*<)/i,
  },
  { agent: "copilot", pattern: /(copilot@github\.com|\bgithub copilot\b)/i },
  { agent: "cursor", pattern: /(@cursor\.(com|sh)|\bcursor agent\b)/i },
  { agent: "devin", pattern: /(devin@cognition|@cognition-labs\.com|\bdevin ai\b)/i },
  { agent: "codex", pattern: /(codex@openai\.com|\bopenai codex\b)/i },
  { agent: "aider", pattern: /\baider\b/i },
  { agent: "gemini", pattern: /(@google\.com.*gemini|\bgemini(-| )?cli\b)/i },
];

/** Body markers used by tools that advertise themselves outside a trailer. */
const GENERATED_MARKERS = [
  /generated with \[?claude code/i,
  /🤖 generated with/i,
  /co-?authored by an ai agent/i,
];

const COAUTHOR_KEYS = new Set(["co-authored-by", "coauthored-by"]);
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+)$/;
const REVERT_SUBJECT = /^revert[\s"']/i;
const REVERT_BODY = /this reverts commit ([0-9a-f]{7,40})/i;
const FIX_SUBJECT = /^(fix|hotfix|bugfix|patch|repair|correct)\b|^(fix|revert)[(:]/i;

/**
 * Files that almost every change touches. Linking two commits through one of these produces
 * a rework signal that is pure coincidence, so they are excluded from overlap matching.
 */
const NOISY_FILES =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|poetry\.lock|requirements\.txt|CHANGELOG\.md)$/i;

/**
 * A file touched by more than this share of commits carries no per-change signal either.
 * The absolute floor matters as much as the share: in a ten-commit history almost every
 * file clears a percentage threshold, and filtering them all would empty the analysis.
 */
const NOISY_FILE_SHARE = 0.25;
const NOISY_FILE_MIN_TOUCHES = 5;

/**
 * A "fix" touching this many files is a sweep — a lint pass, a formatting run, a build
 * repair — and attributing it to every change it brushes against would mark most of the
 * history as failed. Sweeps are still counted as commits; they just cannot convict.
 */
const MAX_FIX_FANOUT = 20;

const DAY_MS = 86_400_000;

/**
 * Extract key/value trailers from a commit body.
 *
 * Follows git's own rule: trailers live in the final paragraph, and that paragraph only
 * counts when every line in it is trailer-shaped. A key may not contain spaces, which is
 * what keeps a prose line like "Some note: see the ticket" from being read as metadata.
 */
export function parseTrailers(body) {
  if (!body) return [];
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return [];

  const lines = last
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const matches = lines.map((line) => TRAILER_LINE.exec(line));
  if (matches.some((match) => match === null)) return [];

  return matches.map((match) => ({ key: match[1].toLowerCase(), value: match[2].trim() }));
}

/**
 * Decide whether a commit was agent-authored, and by which vendor.
 *
 * Matching is deliberately anchored on the co-author identity rather than a loose body
 * search: a human named Claudia must never be scored as a machine, because a single
 * false positive discredits the whole report with the team being measured.
 */
export function classifyProvenance(commit) {
  const trailers = parseTrailers(commit.body);
  for (const trailer of trailers) {
    if (!COAUTHOR_KEYS.has(trailer.key)) continue;
    const identity = `${trailer.value} <`;
    for (const signature of AGENT_SIGNATURES) {
      if (signature.pattern.test(identity)) {
        return { provenance: "agent", agent: signature.agent, trailers };
      }
    }
  }
  if (GENERATED_MARKERS.some((marker) => marker.test(commit.body ?? ""))) {
    return { provenance: "agent", agent: "unknown", trailers };
  }
  return { provenance: "human", agent: null, trailers };
}

const isRevert = (commit) =>
  REVERT_SUBJECT.test(commit.subject ?? "") || REVERT_BODY.test(commit.body ?? "");

const isFix = (commit) => FIX_SUBJECT.test(commit.subject ?? "");

const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);

const round = (value, places = 4) =>
  value === null ? null : Number.parseFloat(value.toFixed(places));

function emptyCohort() {
  return {
    commits: 0,
    lines: 0,
    subjects: 0,
    reverted: 0,
    reworked: 0,
    failed: 0,
    revertRate: null,
    reworkRate: null,
    failureRate: null,
  };
}

/**
 * Analyze a list of commits and produce a load-line report.
 *
 * @param {Array<object>} commits Commits in any order; each needs sha, date, subject, body,
 *   insertions, deletions and files.
 * @param {{reworkWindowDays?: number}} [options]
 */
export function analyze(commits, options = {}) {
  const reworkWindowDays = options.reworkWindowDays ?? 14;
  const window = reworkWindowDays * DAY_MS;

  const enriched = commits
    .map((commit) => ({
      ...commit,
      ...classifyProvenance(commit),
      lines: (commit.insertions ?? 0) + (commit.deletions ?? 0),
      timestamp: Date.parse(commit.date),
      revert: isRevert(commit),
      fix: isFix(commit),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const bySha = new Map(enriched.map((commit) => [commit.sha, commit]));
  const revertedShas = new Set();
  for (const commit of enriched) {
    const match = REVERT_BODY.exec(commit.body ?? "");
    if (!match) continue;
    // Reverts may abbreviate the target sha, so resolve by prefix when there is no exact hit.
    const target =
      bySha.get(match[1]) ?? enriched.find((candidate) => candidate.sha.startsWith(match[1]));
    if (target) revertedShas.add(target.sha);
  }

  // A commit is "reworked" when a later fix-shaped commit touches a file it changed, inside
  // the window. This is a proxy for change failure, not a measurement of it: teams with real
  // incident data should join on that instead, and the report says so.
  const touchCount = new Map();
  for (const commit of enriched) {
    for (const file of new Set(commit.files ?? [])) {
      touchCount.set(file, (touchCount.get(file) ?? 0) + 1);
    }
  }
  const noisy = (file) => {
    if (NOISY_FILES.test(file)) return true;
    const touches = touchCount.get(file) ?? 0;
    return touches >= NOISY_FILE_MIN_TOUCHES && touches / enriched.length > NOISY_FILE_SHARE;
  };

  const reworkedShas = new Set();
  const fixes = enriched.filter(
    (commit) => (commit.fix || commit.revert) && (commit.files ?? []).length <= MAX_FIX_FANOUT,
  );
  for (const subject of enriched) {
    if (subject.fix || subject.revert) continue;
    const files = new Set((subject.files ?? []).filter((file) => !noisy(file)));
    if (files.size === 0) continue;
    const hit = fixes.some(
      (fix) =>
        fix.timestamp > subject.timestamp &&
        fix.timestamp - subject.timestamp <= window &&
        (fix.files ?? []).some((file) => files.has(file)),
    );
    if (hit) reworkedShas.add(subject.sha);
  }

  const cohorts = { agent: emptyCohort(), human: emptyCohort() };
  const byAgent = {};
  let agentLines = 0;
  let totalLines = 0;

  for (const commit of enriched) {
    const cohort = cohorts[commit.provenance];
    cohort.commits += 1;
    cohort.lines += commit.lines;
    totalLines += commit.lines;
    if (commit.provenance === "agent") {
      agentLines += commit.lines;
      byAgent[commit.agent] = (byAgent[commit.agent] ?? 0) + 1;
    }

    // Remediation commits are excluded as subjects: they are the response to risk, not a
    // new unit of it, and scoring them would flatter whichever cohort does the cleanup.
    if (commit.fix || commit.revert) continue;
    cohort.subjects += 1;
    const reverted = revertedShas.has(commit.sha);
    const reworked = reworkedShas.has(commit.sha);
    if (reverted) cohort.reverted += 1;
    if (reworked) cohort.reworked += 1;
    if (reverted || reworked) cohort.failed += 1;
  }

  for (const cohort of Object.values(cohorts)) {
    cohort.revertRate = round(ratio(cohort.reverted, cohort.subjects));
    cohort.reworkRate = round(ratio(cohort.reworked, cohort.subjects));
    cohort.failureRate = round(ratio(cohort.failed, cohort.subjects));
  }

  const riskRatio =
    cohorts.human.failureRate === null || cohorts.human.failureRate === 0
      ? null
      : round(cohorts.agent.failureRate / cohorts.human.failureRate, 3);

  const period = enriched.length
    ? { from: enriched[0].date, to: enriched[enriched.length - 1].date }
    : { from: null, to: null };

  return {
    period,
    totals: { commits: enriched.length, lines: totalLines },
    loadLine: {
      agentLineShare: round(totalLines === 0 ? 0 : agentLines / totalLines),
      agentCommitShare: round(enriched.length === 0 ? 0 : cohorts.agent.commits / enriched.length),
      byAgent,
    },
    cohorts,
    risk: {
      ratio: riskRatio,
      basis: "revert-or-rework within the window",
      reworkWindowDays,
      confident: cohorts.agent.subjects >= 30 && cohorts.human.subjects >= 30,
    },
  };
}
