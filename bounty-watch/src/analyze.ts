/**
 * Bounty intake analyzer. Given a program URL, it reports what a submission needs
 * and whether the researcher is even eligible — deliberately NOT the vulnerability
 * itself. Producing findings for a researcher to submit as their own is banned on
 * these platforms and risks a KYC-linked account, so this tool stops at the line
 * between "what a valid report must contain" and "the report."
 */
export type Platform = "cantina" | "algora" | "immunefi" | "sherlock" | "codehawks" | "unknown";

export interface ProgramRef {
  readonly platform: Platform;
  readonly id: string | null;
  readonly url: string;
}

export function parseProgramUrl(url: string): ProgramRef {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, "");
    path = parsed.pathname;
  } catch {
    return { platform: "unknown", id: null, url };
  }

  const platform: Platform = host.includes("cantina")
    ? "cantina"
    : host.includes("algora")
      ? "algora"
      : host.includes("immunefi")
        ? "immunefi"
        : host.includes("sherlock")
          ? "sherlock"
          : host.includes("codehawks") || host.includes("cyfrin")
            ? "codehawks"
            : "unknown";

  // Cantina paths look like /code/<uuid>/... or /bounties/<uuid> or /competitions/<uuid>.
  const uuid = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return { platform, id: uuid ? uuid[0] : null, url };
}

/** The report a valid smart-contract finding must contain, common across platforms. */
export const SUBMISSION_CHECKLIST = [
  "Title: one line naming the bug and the affected contract/function",
  "Severity: your claim (critical/high/medium/low) with the impact that justifies it",
  "Affected code: exact file, function and line(s), quoted",
  "Description: what is wrong in the logic, stated precisely",
  "Impact: what an attacker gains or what users lose, in concrete terms",
  "Preconditions: the state and permissions required for the bug to trigger",
  "Steps to reproduce: an ordered, runnable sequence",
  "Proof of concept: a test (e.g. Foundry) that fails without a fix and passes with one",
  "Recommended fix: the minimal code change that resolves it",
] as const;

export interface Eligibility {
  readonly mustBeFirst: boolean;
  readonly kycLikely: boolean;
  readonly aiSubmissionsForbidden: "yes" | "no" | "unknown";
  readonly notes: readonly string[];
}

/**
 * Eligibility rules that are constant per platform. AI-forbidden is the one that can
 * disqualify an AI-assisted researcher outright, so it is surfaced first and, when the
 * program's own text has not been read, reported as "unknown" rather than assumed safe.
 */
export function platformEligibility(platform: Platform): Eligibility {
  const base = { mustBeFirst: true } as const;
  switch (platform) {
    case "cantina":
      return {
        ...base,
        kycLikely: true,
        // Some Cantina programs (e.g. Coinbase) list "submissions generated using LLM
        // tools" as out of scope; the per-program page is the source of truth and is
        // login-gated, so this cannot be auto-confirmed.
        aiSubmissionsForbidden: "unknown",
        notes: [
          "Read the program's own Out-of-Scope section: if it lists LLM/ChatGPT-generated submissions, an AI-written report is ineligible.",
          "Reward is at the sponsor's discretion and depends on report quality and a working PoC.",
        ],
      };
    case "immunefi":
      return {
        ...base,
        kycLikely: true,
        aiSubmissionsForbidden: "unknown",
        notes: ["A runnable PoC is usually mandatory."],
      };
    case "sherlock":
    case "codehawks":
      return {
        ...base,
        kycLikely: false,
        aiSubmissionsForbidden: "unknown",
        notes: ["Contest payouts split a pool across valid findings."],
      };
    case "algora":
      return {
        ...base,
        kycLikely: false,
        aiSubmissionsForbidden: "no",
        notes: [
          "AI-assisted PRs are generally accepted when disclosed; state that the change was AI-assisted.",
        ],
      };
    default:
      return {
        ...base,
        kycLikely: false,
        aiSubmissionsForbidden: "unknown",
        notes: ["Unrecognized platform; read its rules directly."],
      };
  }
}

export interface AnalysisFacts {
  readonly name?: string;
  readonly rewardPot?: number;
  readonly currency?: string;
  readonly status?: string;
  readonly kycRequired?: boolean;
  readonly sourcePublic?: boolean;
}

export interface Analysis {
  readonly ref: ProgramRef;
  readonly eligibility: Eligibility;
  readonly checklist: readonly string[];
  readonly facts: AnalysisFacts;
}

export function analyze(url: string, facts: AnalysisFacts = {}): Analysis {
  const ref = parseProgramUrl(url);
  return {
    ref,
    eligibility: platformEligibility(ref.platform),
    checklist: [...SUBMISSION_CHECKLIST],
    facts,
  };
}

export function formatAnalysis(analysis: Analysis): string {
  const { ref, eligibility, facts, checklist } = analysis;
  const lines: string[] = [];
  lines.push(`Program: ${facts.name ?? ref.id ?? "(unknown)"}  [${ref.platform}]`);
  if (facts.rewardPot)
    lines.push(
      `Max/pool: ${facts.rewardPot.toLocaleString("en-US")} ${facts.currency ?? ""}`.trimEnd(),
    );
  if (facts.status) lines.push(`Status: ${facts.status}`);
  lines.push("");

  lines.push("Eligibility:");
  lines.push(`  KYC likely required: ${eligibility.kycLikely ? "yes" : "no"}`);
  const ai =
    eligibility.aiSubmissionsForbidden === "yes"
      ? "FORBIDDEN — an AI-written report is ineligible here"
      : eligibility.aiSubmissionsForbidden === "no"
        ? "allowed if disclosed"
        : "UNKNOWN — check the program's Out-of-Scope section before writing anything";
  lines.push(`  AI-generated submissions: ${ai}`);
  lines.push(`  Must be first to report: ${eligibility.mustBeFirst ? "yes" : "no"}`);
  for (const note of eligibility.notes) lines.push(`  - ${note}`);
  lines.push("");

  lines.push("A valid submission must contain:");
  for (const item of checklist) lines.push(`  [ ] ${item}`);
  lines.push("");
  lines.push(
    "This tool reports requirements only. It does not and will not write the finding for you:",
  );
  lines.push(
    "an AI-authored report submitted as your own is banned on these platforms and can get a KYC-linked account banned.",
  );
  return lines.join("\n");
}
