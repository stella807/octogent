#!/usr/bin/env node
import process from "node:process";
import { readCommits, repoName } from "./git.mjs";
import { analyze } from "./provenance.mjs";
import { renderReport } from "./render.mjs";

const USAGE = `plimsoll — the load line for agent-written code

  plimsoll [path] [options]

  --since <date>     only consider commits after this date (default: 12 months ago)
  --window <days>    rework window used to attribute follow-up fixes (default: 14)
  --json             emit the raw report as JSON
  --help             show this message

Reads git history locally. No code, diff content or commit text leaves this machine.
`;

function parseArgs(argv) {
  const options = { repo: ".", since: "12 months ago", window: 14, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--json") options.json = true;
    else if (arg === "--since") options.since = argv[++i];
    else if (arg === "--window") options.window = Number.parseInt(argv[++i], 10);
    else if (!arg.startsWith("-")) options.repo = arg;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isFinite(options.window) || options.window <= 0) {
    throw new Error("--window must be a positive number of days");
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const commits = await readCommits(options.repo, { since: options.since });
  const report = analyze(commits, { reworkWindowDays: options.window });
  report.repo = await repoName(options.repo);

  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report),
  );
}

main().catch((error) => {
  process.stderr.write(`plimsoll: ${error.message}\n`);
  process.exitCode = 1;
});
