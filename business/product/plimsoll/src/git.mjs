import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// ASCII record/unit separators keep multi-line commit bodies parseable without escaping.
const RECORD = "\u001e";
const UNIT = "\u001f";
const FORMAT = `${RECORD}%H${UNIT}%an${UNIT}%ae${UNIT}%aI${UNIT}%s${UNIT}%b${UNIT}`;

/**
 * Read commits from a repository.
 *
 * Merge commits are excluded: they carry no authorship of their own and would double-count
 * the lines of everything they merge.
 */
export async function readCommits(repoPath, { since } = {}) {
  const args = ["-C", repoPath, "log", "--no-merges", "--numstat", `--format=${FORMAT}`];
  if (since) args.push(`--since=${since}`);

  const { stdout } = await run("git", args, { maxBuffer: 256 * 1024 * 1024 });

  const commits = [];
  for (const record of stdout.split(RECORD)) {
    if (!record.trim()) continue;
    const [sha, author, email, date, subject, body, rest = ""] = record.split(UNIT);

    let insertions = 0;
    let deletions = 0;
    const files = [];
    for (const line of rest.split("\n")) {
      const parts = line.trim().split("\t");
      if (parts.length < 3) continue;
      const [added, removed, path] = parts;
      // "-" marks a binary file; count the path but not the lines.
      if (added !== "-") insertions += Number.parseInt(added, 10) || 0;
      if (removed !== "-") deletions += Number.parseInt(removed, 10) || 0;
      files.push(path);
    }

    commits.push({ sha, author, email, date, subject, body, insertions, deletions, files });
  }
  return commits;
}

export async function repoName(repoPath) {
  try {
    const { stdout } = await run("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
    return stdout.trim().split("/").pop();
  } catch {
    return repoPath;
  }
}
