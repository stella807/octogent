# plimsoll

**The load line for agent-written code.**

Reports what share of a repository's merged changes were written with an AI coding agent,
and whether those changes fail more often than human-authored ones.

Runs entirely locally against `git log`. **No code, diff content or commit text leaves the
machine.** No dependencies. Node 22+.

## Use

```bash
node src/cli.mjs /path/to/repo --since "12 months ago"
node src/cli.mjs . --window 21 --json
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--since <date>` | `12 months ago` | Any date expression git accepts |
| `--window <days>` | `14` | Window for attributing a follow-up fix as rework |
| `--json` | off | Emit the raw report |

## Example

```
  PLIMSOLL  octogent
  2026-04-08 → 2026-09-21   57 commits, 79069 lines changed

  LOAD LINE — share of changed lines written with an agent
  ███·····························  10.0%
  agents seen: claude (7)

  COHORTS
           commits    lines   scored  revert  rework  failure
  agent          7     7907        7    0.0%    0.0%     0.0%
  human         50    71162       46    0.0%   21.7%    21.7%

  RISK RATIO   0×   LOW CONFIDENCE
  fewer than 30 commits in a cohort; treat as directional
```

## How it works

**Attribution.** Agentic coding tools write `Co-Authored-By` trailers by default and git
trailers survive rebase, so provenance is already in history. Trailers are parsed with git's
own rule — the final paragraph only, and only when every line in it is trailer-shaped — and
matched against known vendor identities. Matching is anchored on the co-author identity
rather than a loose body search, so a human named Claudia is never scored as a machine.

**Failure proxy.** A change is counted as failed if it was reverted, or if a fix-shaped
commit touched one of its files within the window.

Three rules keep that proxy honest. Each one was added because the naive version produced a
visibly wrong number on real history:

1. **Remediation commits are not scored as subjects.** A fix is the response to risk, not a
   new unit of it.
2. **High-traffic files cannot link two changes.** Lockfiles, and any file touched by more
   than 25% of commits (minimum 5 touches), carry no per-change signal.
3. **A "fix" touching more than 20 files is a sweep and cannot convict.** A `fix lint` across
   the tree is maintenance, not a remediation of any one change. On this repository, this
   rule alone moved the measured human rework rate from **71.7% to 21.7%**.

**Confidence.** Below 30 scored commits in either cohort the report says `LOW CONFIDENCE`
rather than presenting a ratio as fact.

## Limits — stated plainly

- Revert-or-rework is a **proxy** for change failure rate, not a measurement of it. Join your
  own incident data before running policy off the number.
- Commits without trailers are counted as human-authored. Agent work committed without a
  trailer is undercounted, so the load line is a **floor**, not an estimate.
- Squash-merge workflows collapse many changes into one commit, which coarsens the analysis.
- It cannot see pull requests, review behaviour, CI outcomes or incidents. That is what the
  hosted product is for.

## Design

```
src/provenance.mjs   pure analysis — no I/O, fully unit tested
src/git.mjs          the only place that shells out to git
src/render.mjs       terminal presentation, no analysis
src/cli.mjs          argument parsing and wiring
```

Pure core, thin adapters. The analysis has no knowledge of git or of terminals, which is
what makes the 18 tests possible without fixtures.

## Test

```bash
node --test 'test/*.test.mjs'
```
