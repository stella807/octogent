# bounty-watch

Polls [Algora](https://algora.io) organization boards and reports **newly opened** bounties.

## Why this exists

Algora publishes no global bounty feed. `algora.io/bounties` returns 404, `console.algora.io/bounties`
redirects to that same dead URL, and the documented API host was unreachable when this was built.
Boards are per-organization only, so the sole way to notice a new bounty is to poll each org you care
about and diff the result against what you saw last time. That is all this tool does.

Two findings are baked into the implementation, both verified against live pages:

- The bounty tables live at `algora.io/<org>/bounties/community`. Plain `/<org>/bounties` renders no
  bounty tables at all.
- Open and completed bounties use **identical row markup** and are distinguishable only by which
  heading they fall under, so the parser slices the page by heading offset. A row outside both
  sections is dropped rather than guessed at.

## Usage

```sh
pnpm install
pnpm cli once                 # poll every board once, print what is new
pnpm cli once --min 0         # include bounties below the watchlist floor
pnpm cli once --json          # machine-readable report
pnpm cli watch --interval 60  # poll hourly until interrupted
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--watchlist <path>` | `./watchlist.json` | Boards to poll |
| `--state <path>` | `./.bounty-watch-state.json` | Which bounties were already reported |
| `--min <usd>` | watchlist value | Override the reward floor |
| `--interval <min>` | `30` | Minutes between polls in `watch` mode (floor: 5) |

## Watchlist

`watchlist.json` holds the org slugs to poll and a reward floor. Nine slugs are included, each
confirmed to serve a real board. Add an org by dropping its slug in; `path` overrides the board path
for orgs that do not use the community layout.

```json
{ "minAmountUsd": 50, "entries": ["coollabsio", { "slug": "cal", "path": "bounties/community" }] }
```

The default floor is $50 because the setup cost (Stripe KYC, repo access) dwarfs a $20 payout.

## State and reliability

Seen bounties persist to a state file keyed `<org>::<issue-url>`, so the same issue posted on two
boards is tracked separately. If a board fails to load, its previously-seen ids are **retained** — the
poller only prunes boards it actually reached, so a transient 503 cannot cause that org's whole
backlog to be re-announced as new on the next successful poll. A missing or corrupt state file is
treated as a cold start rather than a crash.

Requests are sequential with a 1.5s pause between boards and a descriptive User-Agent.

## Caveats

This scrapes server-rendered HTML because no API is available. Algora can change its markup at any
time, which would break parsing. `test/fixtures/coolify-bounties.html` is real, unmodified markup
captured 2026-09-23; if the parser starts returning nothing, re-capture that fixture and compare.

## Tests

```sh
pnpm test        # 37 tests, no network access
pnpm typecheck
```

Parser tests run against the saved real-HTML fixture, not hand-written markup.
