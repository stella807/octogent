#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, formatAnalysis } from "./analyze.ts";
import { fetchContests, formatContests } from "./cantina.ts";
import { HttpBoardClient } from "./client.ts";
import { HttpIssueStateClient } from "./liveness.ts";
import { pollOnce } from "./poll.ts";
import { formatReport } from "./report.ts";
import { FileSeenStore } from "./store.ts";
import { WatchlistError, loadWatchlist } from "./watchlist.ts";

const USAGE = `bounty-watch — poll Algora org boards for newly opened bounties

Usage:
  bounty-watch once   [options]   Poll every board once and print what is new
  bounty-watch watch  [options]   Poll on an interval until interrupted
  bounty-watch contests           List live or upcoming Cantina audit contests
  bounty-watch analyze <url>      Show eligibility and the required submission checklist for a program

Options:
  --watchlist <path>   Watchlist JSON (default: ./watchlist.json)
  --state <path>       Seen-bounty state file (default: ./.bounty-watch-state.json)
  --min <usd>          Override the watchlist reward floor
  --interval <min>     Minutes between polls in watch mode (default: 30, min: 5)
  --no-verify          Skip the upstream check for already-closed issues
  --json               Print the raw report as JSON
  -h, --help           Show this message
`;

interface Args {
  readonly command: string;
  readonly watchlist: string;
  readonly state: string;
  readonly min?: number;
  readonly intervalMin: number;
  readonly json: boolean;
  readonly verify: boolean;
  readonly help: boolean;
}

// Polling faster than this adds no signal — bounties are posted by humans — and only
// risks Algora rate-limiting the watchlist.
const MIN_INTERVAL_MIN = 5;

export function parseArgs(argv: readonly string[]): Args {
  const rest = [...argv];
  const command = rest[0]?.startsWith("-") ? "once" : (rest.shift() ?? "once");

  const read = (flag: string): string | undefined => {
    const index = rest.indexOf(flag);
    return index === -1 ? undefined : rest[index + 1];
  };

  const minRaw = read("--min");
  const intervalRaw = read("--interval");
  const min = minRaw === undefined ? undefined : Number(minRaw);
  const interval = intervalRaw === undefined ? 30 : Number(intervalRaw);

  if (min !== undefined && (!Number.isFinite(min) || min < 0)) {
    throw new Error("--min must be a non-negative number");
  }
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MIN) {
    throw new Error(`--interval must be at least ${MIN_INTERVAL_MIN} minutes`);
  }

  return {
    command,
    watchlist: resolve(read("--watchlist") ?? "watchlist.json"),
    state: resolve(read("--state") ?? ".bounty-watch-state.json"),
    ...(min === undefined ? {} : { min }),
    intervalMin: interval,
    json: rest.includes("--json"),
    verify: !rest.includes("--no-verify"),
    help: rest.includes("--help") || rest.includes("-h"),
  };
}

async function runOnce(args: Args): Promise<void> {
  const base = await loadWatchlist(args.watchlist);
  const watchlist = args.min === undefined ? base : { ...base, minAmountUsd: args.min };

  const report = await pollOnce({
    client: new HttpBoardClient(),
    store: new FileSeenStore(args.state),
    watchlist,
    ...(args.verify ? { issueState: new HttpIssueStateClient() } : {}),
  });

  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (argv[0] === "analyze") {
    const url = argv[1];
    if (!url) {
      console.error("usage: bounty-watch analyze <program-url>");
      return 2;
    }
    console.log(formatAnalysis(analyze(url)));
    return 0;
  }

  if (args.command === "contests") {
    try {
      console.log(formatContests(await fetchContests()));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (args.help || args.command === "help") {
    console.log(USAGE);
    return 0;
  }

  try {
    if (args.command === "once") {
      await runOnce(args);
      return 0;
    }
    if (args.command === "watch") {
      console.log(`Watching every ${args.intervalMin}m. Ctrl-C to stop.`);
      for (;;) {
        await runOnce(args);
        await new Promise((r) => setTimeout(r, args.intervalMin * 60_000));
      }
    }
    console.error(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof WatchlistError) {
      console.error(error.message);
      return 2;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only run when invoked directly: importing this module (tests, tooling) must not
// start a poll or touch the network.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
