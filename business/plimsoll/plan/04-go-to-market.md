# Go to market — the first 90 days

The whole motion rests on one asset: **a number about you that you did not have before.**
That is inherently shareable, inherently specific, and impossible to get from a blog post.

## Principle

Lead with the measurement, never with the product. Every piece of content, every
conversation, and every post should end at the same place: *run it on your own repo and see.*

## Days 1–30 — publish the instrument

**Goal:** 200 report runs, 20 conversations, 2 audits sold.

1. **Ship `@plimsoll/report` to npm.** MIT licensed. The analysis engine is open source; the
   hosted joins and gates are not. Open source here is not generosity, it is the only way to
   get a security-sensitive buyer to run your code on their private history in week one.
2. **Publish the methodology before the findings.** A written spec of how provenance is
   attributed and how failure is proxied, including its weaknesses. In a market where
   everyone is quoting everyone else's aggregate statistics, being the person who publishes
   a reproducible method is the entire differentiation.
3. **Publish "We measured 50 open-source repositories."** Run the tool across large public
   repos with meaningful agent adoption, publish the aggregate and the per-repo data, and
   hand over the script so anyone can check it. This is the launch artefact. It works whether
   the finding is alarming *or* reassuring — a credible "actually, it is fine" is just as
   publishable and considerably more trustworthy.
4. **Where to post:** Hacker News (the methodology piece, not the product), r/ExperiencedDevs,
   Lobsters, the Claude Code / Cursor / Copilot community Discords, and the four or five
   engineering-leadership newsletters that covered the Cortex benchmark.
5. **Direct outreach, 10/day, hand-written.** Target: VP Eng / Director of Platform at
   100–1,000 person engineering orgs that have publicly said they adopted agentic coding.
   The message is three sentences and contains their own number if the repo is public.

## Days 31–60 — convert measurement into engagements

**Goal:** 4 audits delivered, first 5 Cloud design partners, methodology cited by someone else.

1. **Deliver the first audits personally and over-deliver.** These are references, and one
   named logo is worth more than the next ten cold emails.
2. **Turn each audit into an anonymised teardown** — "what we found in a 200-engineer
   fintech" — published with the customer's approval. This is the highest-converting content
   in the entire plan because it is the only place the buyer sees their own situation.
3. **Recruit 5 design partners** for Cloud at $0 for 3 months in exchange for weekly
   feedback and a reference. Design partners are chosen for how hard they will push back,
   not how easily they said yes.
4. **Ship the GitHub App** (read-only: PRs, checks, deployments) — the minimum needed to
   turn a one-off report into a trend line.

## Days 61–90 — make it continuous

**Goal:** first paying Cloud customers, a repeatable audit that is no longer bespoke.

1. **Launch Cloud Team publicly** at $499/mo, converting design partners at a permanent
   50% discount, honoured indefinitely.
2. **Ship the weekly digest.** The retention mechanic is a number that changes and arrives
   on its own. A dashboard nobody opens churns; a Monday email with a moving line does not.
3. **Productise the audit** into a five-day version at the same price, once the tooling does
   what the first four were done by hand.
4. **Start the benchmark.** Aggregate, anonymised, opt-in: "your agent-authored failure ratio
   versus the median of 40 comparable teams." This is the long-term moat — a comparison
   nobody can replicate without the same customer base — and it is why the data model has to
   be built for aggregation from day one.

## Channels, ranked by expected yield

| Channel | Why it works here | Cost |
| --- | --- | --- |
| Open-source CLI + methodology | Removes trust barrier; self-distributing | Time |
| Public repo benchmark study | Novel data, citable, press-friendly | Time |
| Anonymised audit teardowns | Buyer recognises themselves | Time |
| Engineering-leadership newsletters | Exactly the buyer, already reading about this | Time / small sponsorship |
| Conference talk on the methodology | Credibility with the security-adjacent buyer | Travel |
| Cold outreach with their own number | Unreasonably effective when the repo is public | Time |
| Paid search | Nobody is searching for this category yet | Skip in year one |

## What would make us stop

Stated in advance so they are tests rather than rationalisations:

- **Under 150 report runs in 60 days.** The wedge is not interesting. Fix the artefact
  before spending another day on the funnel.
- **Zero audits sold from 30+ qualified conversations.** The pain is real but not budgeted.
  Re-target toward the compliance buyer, where it is.
- **Audits sell but nobody converts to Cloud.** The problem is a one-time diagnostic, not a
  monitoring need. That is a consultancy, and a decent one — but it is not this business,
  and the plan should change rather than the goal being restated.
