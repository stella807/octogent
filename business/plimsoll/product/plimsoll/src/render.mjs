/** Terminal rendering for a load-line report. Presentation only; no analysis here. */

const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const bar = (share, width = 32) => {
  const filled = Math.round((share ?? 0) * width);
  return `${"█".repeat(filled)}${"·".repeat(width - filled)}`;
};

/**
 * Turn the risk ratio into a verdict.
 *
 * The thresholds are deliberately wide. A ratio is a noisy estimate on a single repository,
 * and the honest product decision is to say "not enough signal" rather than to manufacture
 * a precise-looking number a team would take into a planning meeting.
 */
function verdict(report) {
  const { ratio, confident } = report.risk;
  if (ratio === null)
    return { label: "NO BASELINE", note: "no human-authored failures to compare against" };
  if (!confident)
    return {
      label: "LOW CONFIDENCE",
      note: "fewer than 30 commits in a cohort; treat as directional",
    };
  if (ratio >= 1.5)
    return { label: "ABOVE THE LINE", note: "agent-authored changes fail materially more often" };
  if (ratio >= 1.15)
    return { label: "RIDING LOW", note: "agent-authored changes fail somewhat more often" };
  if (ratio <= 0.85)
    return { label: "BELOW THE LINE", note: "agent-authored changes fail less often" };
  return { label: "LEVEL", note: "no meaningful difference between cohorts" };
}

export function renderReport(report) {
  const { loadLine, cohorts, risk, totals, period } = report;
  const state = verdict(report);
  const agents = Object.entries(loadLine.byAgent)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");

  const row = (label, cohort) =>
    [
      label.padEnd(9),
      String(cohort.commits).padStart(7),
      String(cohort.lines).padStart(9),
      String(cohort.subjects).padStart(9),
      pct(cohort.revertRate).padStart(8),
      pct(cohort.reworkRate).padStart(8),
      pct(cohort.failureRate).padStart(9),
    ].join("");

  return `
  PLIMSOLL  ${report.repo ?? ""}
  ${period.from?.slice(0, 10) ?? "—"} → ${period.to?.slice(0, 10) ?? "—"}   ${totals.commits} commits, ${totals.lines} lines changed

  LOAD LINE — share of changed lines written with an agent
  ${bar(loadLine.agentLineShare)}  ${pct(loadLine.agentLineShare)}
  ${agents ? `agents seen: ${agents}` : "no agent-authored commits found"}

  COHORTS
  ${"".padEnd(9)}${"commits".padStart(7)}${"lines".padStart(9)}${"scored".padStart(9)}${"revert".padStart(8)}${"rework".padStart(8)}${"failure".padStart(9)}
  ${row("agent", cohorts.agent)}
  ${row("human", cohorts.human)}

  RISK RATIO   ${risk.ratio === null ? "n/a" : `${risk.ratio}×`}   ${state.label}
  ${state.note}

  Failure here means a change was reverted, or a fix-shaped commit touched one of its files
  within ${risk.reworkWindowDays} days. It is a proxy for change failure rate, not a substitute for incident
  data — join your own incidents to these cohorts before acting on the number.
`;
}
