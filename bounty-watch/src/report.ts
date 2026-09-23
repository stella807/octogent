import type { PollReport } from "./domain/types.ts";

const money = (amount: number): string => `$${amount.toLocaleString("en-US")}`;

/** Human-readable poll summary; the CLI stays thin by delegating formatting here. */
export function formatReport(report: PollReport): string {
  const lines: string[] = [];

  if (report.fresh.length > 0) {
    lines.push(`${report.fresh.length} new bounty(s):`);
    for (const bounty of [...report.fresh].sort((a, b) => b.amountUsd - a.amountUsd)) {
      lines.push(`  ${money(bounty.amountUsd).padStart(8)}  ${bounty.ref}  ${bounty.title}`);
      lines.push(`            ${bounty.url}`);
    }
  } else {
    lines.push("No new bounties.");
  }

  const total = report.open.reduce((sum, bounty) => sum + bounty.amountUsd, 0);
  lines.push(`Open across watchlist: ${report.open.length} bounty(s), ${money(total)} total.`);

  for (const error of report.errors) {
    lines.push(`  ! ${error.slug}: ${error.message}`);
  }

  return lines.join("\n");
}
