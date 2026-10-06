# bounty-watch

Polls [Algora](https://algora.io) organization boards and [Cantina](https://cantina.xyz) bug bounty
programs, and reports **newly opened** bounties.

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

## Cantina

Cantina has a JSON API at `cantina.xyz/api/v0/opportunities`, but its `robots.txt` disallows `/api/`,
so the poller never calls it. It reads only pages crawlers may fetch, combining two incomplete views:

- `/opportunities/bounties` embeds the **top ten programs by reward pot**, and is current.
- `/sitemap.xml` lists **every program page**, but is regenerated only every few days.

Programs the listing page did not cover are read from their own `/bounties/<uuid>` page. Cantina is a
Next.js app, so program data lives in the React Server Components payload (`self.__next_f.push(...)`
string literals), not in the markup. Text rows in that stream (`<id>:T<hex byte length>,<markdown>`)
end after a byte count with no newline, so the parser walks the stream by length rather than lines.

What that means in practice:

- A new program with a top-ten pot is reported on the next poll; a smaller one once the sitemap catches
  up. When this was built, Cantina's own counter showed 51 current bounties and the crawlable pages
  exposed 28 live ones, so some programs stay invisible until they reach the sitemap.
- Only programs with status `live` count as open; `judging`, `paused` and finished ones do not.
- The amount is the program's **maximum payout pot**, so the report prints it as `up to $X` and never
  adds it to the Algora reward total. A pot paid in something other than USD or a USD stablecoin is
  shown in its own currency (e.g. `up to 125,000 BOLD`).
- One poll costs ~35 requests at 1.5s apart (about a minute). The sitemap is capped at 200 unread
  program pages per poll, and child sitemaps on another host are never followed.
- If no program can be parsed at all, the board errors instead of reporting zero, so a markup change
  cannot prune seen state and re-announce every program later.

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

`watchlist.json` holds the boards to poll and a reward floor. Nine Algora slugs are included, each
confirmed to serve a real board, plus Cantina. Add an Algora org by dropping its slug in; `path`
overrides the board path for orgs that do not use the community layout. Cantina is one site-wide board,
enabled with `{ "source": "cantina" }` (its `slug` is only the label it is tracked under).

```json
{
  "minAmountUsd": 50,
  "entries": ["coollabsio", { "slug": "cal", "path": "bounties/community" }, { "source": "cantina" }]
}
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

This scrapes server-rendered pages because no API may be polled. Either site can change its markup at
any time, which would break parsing. `test/fixtures/coolify-bounties.html` is real, unmodified markup
captured 2026-09-23; `test/fixtures/cantina-program.html` is the unmodified RSC payload script of a real
Cantina program page and `cantina-sitemap.xml` an excerpt of the real sitemap (program URLs kept),
both captured 2026-10-06. If a parser starts returning nothing, re-capture the fixture and compare.

## Tests

```sh
pnpm test        # 67 tests, no network access
pnpm typecheck
```

Parser tests run against the saved real fixtures, not only hand-written markup.
