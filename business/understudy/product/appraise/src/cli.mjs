#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { appraise } from "./appraise.mjs";
import { renderReport } from "./render.mjs";

const USAGE = `understudy appraise — what your business would fetch, and what each gap is worth

  appraise <profile.json> [--json]

Estimates a likely sale range from seller's discretionary earnings and the risks a buyer
or an SBA lender prices, then puts a dollar figure on closing each one.

This is not a certified valuation and is not an offer to broker a sale.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const path = args.find((arg) => !arg.startsWith("-"));
  if (!path) {
    process.stderr.write(`no profile given\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const profile = JSON.parse(await readFile(path, "utf8"));
  const result = appraise(profile);

  process.stdout.write(
    args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result),
  );
}

main().catch((error) => {
  process.stderr.write(`appraise: ${error.message}\n`);
  process.exitCode = 1;
});
