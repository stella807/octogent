import type { Bounty, PollReport } from "./domain/types.ts";

const money = (amount: number): string => `$${amount.toLocaleString("en-US")}`;

// A Cantina amount is a program's maximum payout, not a reward for one fix, so it is
// labelled as a ceiling and never summed with Algora rewards.
function reward(bounty: Bounty): string {
  const amount = bounty.currency
    ? `${bounty.amountUsd.toLocaleString("en-US")} ${bounty.currency}`
    : money(bounty.amountUsd);
  return bounty.source === "cantina" ? `up to ${amount}` : amount;
}

/** Human-readable poll summary; the CLI stays thin by delegating formatting here. */
export function formatReport(report: PollReport): string {
  const lines: string[] = [];

  if (report.fresh.length > 0) {
    lines.push(`${report.fresh.length} new bounty(s):`);
    for (const bounty of [...report.fresh].sort((a, b) => b.amountUsd - a.amountUsd)) {
      lines.push(`  ${reward(bounty).padStart(8)}  ${bounty.ref}  ${bounty.title}`);
      lines.push(`            ${bounty.url}`);
    }
  } else {
    lines.push("No new bounties.");
  }

  const algora = report.open.filter((bounty) => bounty.source === "algora");
  const cantina = report.open.filter((bounty) => bounty.source === "cantina");
  const total = algora.reduce((sum, bounty) => sum + bounty.amountUsd, 0);
  if (algora.length > 0 || cantina.length === 0) {
    lines.push(`Open across watchlist: ${algora.length} bounty(s), ${money(total)} total.`);
  }
  if (cantina.length > 0) {
    lines.push(`Live Cantina bug bounty programs: ${cantina.length}.`);
  }

  for (const error of report.errors) {
    lines.push(`  ! ${error.slug}: ${error.message}`);
  }

  return lines.join("\n");
}
