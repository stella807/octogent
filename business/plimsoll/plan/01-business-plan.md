# Plimsoll — business plan

> A ship's Plimsoll line marks how heavily it can safely be loaded. Engineering teams now
> carry a large and rising share of machine-written code with no equivalent mark.

## 1. The one-line version

**Plimsoll tells an engineering organisation what share of its merged code was written by an
agent, and whether that code fails more often than the code its people write.**

## 2. The problem

In 2026 the adoption question is settled and the consequences are not. AI writes roughly 42%
of committed code. Incidents per pull request are up 23.5%, change failure rate is up ~30%,
and AI co-authored PRs carry 1.7× the issues and 2.74× the vulnerabilities. Meanwhile 96% of
developers say they do not fully trust the output, and only 48% always verify it.

Every one of those numbers is an **industry aggregate**. No engineering leader can currently
answer the only version of the question that matters to them: *what is it doing to us?*

They are being asked to accept, at scale, a risk they have no instrument to size. Some teams
respond by banning agents (losing the gains), some by ignoring it (accepting the risk
blindly). Both are decisions made without data because the data does not exist.

## 3. The insight

Attribution is already free, and nobody is using it.

Agentic coding tools — Claude Code, Copilot, Cursor, Devin, Codex, Aider — write
`Co-Authored-By` trailers into commits by default, and git trailers survive rebase. That
means **the provenance of every merged change is already recorded in history that every
company already has.** Join it to reverts, follow-up fixes, CI outcomes and incidents, and
the cohort comparison falls out.

No instrumentation. No agent to install. No code leaving the building for the first report.

This was verified before it was written down: the CLI in `business/plimsoll/product/plimsoll/` was
built and run against this repository's real 57-commit history, and building it surfaced
three methodology flaws — lockfile coupling, sweeping "fix lint" commits tarring unrelated
changes, and small-sample thresholds — that a slide would never have caught.

## 4. Product

| Layer | What it is | Status |
| --- | --- | --- |
| **Load Line Report** | Free local CLI. Provenance + revert/rework cohorts from `git log` | **Built.** 18 tests passing |
| **Load Line Audit** | $7,500 two-week engagement. Joins CI, deploys and incidents; leaves a configured merge policy | Deliverable by hand from day one |
| **Plimsoll Cloud** | $499–$1,500/mo. Continuous trend, alerting, per-service thresholds, merge-time gates | Months 4–9 |
| **Benchmark** | Opt-in anonymised comparison against comparable teams | Month 12+ |

The sequence matters: the free tool earns the right to ask, the audit funds the build and
teaches us what to build, the subscription compounds, and the benchmark is the thing a
competitor cannot copy without the same customers.

### What the report measures, precisely

- **Load line** — agent-authored share of changed lines and of commits, split by vendor.
- **Cohort failure rate** — for agent and human cohorts, the share of changes later reverted,
  or touched by a fix-shaped commit within a 14-day window.
- **Risk ratio** — agent failure rate ÷ human failure rate, with an explicit
  `LOW CONFIDENCE` verdict below 30 commits per cohort.

Three deliberate methodology choices, each of which changed the output materially:

1. **Remediation commits are not scored as subjects.** A fix is the response to risk, not a
   new unit of it; scoring them flatters whichever cohort does the cleanup.
2. **High-traffic files cannot link two changes.** Lockfiles and files touched by >25% of
   commits (minimum 5 touches) carry no per-change signal.
3. **A "fix" touching more than 20 files is a sweep, and cannot convict.** On this
   repository, removing that one rule alone cut the measured human rework rate from **71.7%
   to 21.7%** — the difference between a fabricated alarm and a usable number.

The tool prints its own limitations in its own output. In a category where the product is
trust, a number that overstates its certainty is worse than no number.

## 5. Market

- **SAM:** ~15,000 companies, ~$90M at a $6,000 blended ACV (our estimate; derivation in
  `02-market-and-competition.md`).
- **$1M ARR requires ~165 customers** — 0.2% of the serviceable market. That is the only
  penetration figure this plan depends on.

**Competition.** AI code review (CodeRabbit, Greptile, Qodo, Graphite) analyses one PR
pre-merge and cannot produce a rate. LLM observability (Braintrust, Langfuse, Arize) traces
spans inside AI products you ship and is blind to your own repository. The real competitor
is engineering intelligence (LinearB, Jellyfish, Swarmia, Cortex), who could add a
provenance dimension — and whose seat-priced, top-down motion and people-centric data model
make it slower than it looks. **This is a 12–24 month window, not a moat.** The plan is to
convert it into incident-joined data, policy enforcement and a benchmark, which are sticky.

## 6. Business model

| Line | Price | Role |
| --- | --- | --- |
| Report | Free | Acquisition; removes security review from first contact |
| Audit | $7,500 fixed | Cash in months 1–9; product discovery |
| Cloud Team | $499/mo | Land — approvable without a purchase order |
| Cloud Growth | $1,500/mo | Expand — incident joins, gates, SSO |
| Enterprise | From $3,000/mo | Self-hosted, compliance attestation |

Priced **per organisation, not per seat** — deliberately against category convention.
Per-seat pricing falls exactly as the problem grows, because heavy agent adopters have more
machine output and fewer humans. See `03-offer-and-pricing.md`.

## 7. Financial plan

From the runnable model in `business/plimsoll/model/` (`node business/plimsoll/model/run.mjs`):

**Base case**

| | |
| --- | --- |
| First cash-flow-positive month | **5** |
| Deepest cash trough | **−$2,661** |
| Month 24 MRR / ARR | **$57,550 / $690,600** |
| Services revenue, 24 months | $427,500 |
| Total revenue, 24 months | $855,482 |
| Outside capital required | **None** |

Founder draw of $8,000/mo from month 7 and a contractor from month 10 are both costed.

**Downside case** — halved funnel growth, conversion cut by half to two thirds, churn raised
from 3% to 5%:

| | Calendar-gated spending | Revenue-gated spending |
| --- | --- | --- |
| First profitable month | **never** | **9** |
| Deepest cash trough | **−$180,549** | **−$12,498** |
| Cash at month 24 | −$180,549 | +$17,451 |

This comparison is the most useful thing the model produced, and it is the operating rule:

> **The business is not fragile to demand being half of what we hope. It is fragile to
> spending as though it were not.**

Hard gates, adopted as policy:

- **No contractor** until trailing-three-month revenue exceeds $25,000/mo.
- **No founder draw** until trailing-three-month revenue exceeds $15,000/mo.
- **No paid acquisition** in year one.

## 8. Operating plan

| Phase | Months | Focus | Milestone |
| --- | --- | --- | --- |
| Instrument | 1–3 | Ship CLI, publish methodology and the 50-repo study | 200 report runs |
| Engage | 4–6 | Sell and deliver audits by hand; recruit design partners | 4 audits, 5 design partners |
| Productise | 7–12 | GitHub App, continuous trend, weekly digest, Cloud launch | $10k MRR |
| Compound | 13–24 | Incident joins, merge gates, benchmark, enterprise tier | $57k MRR |

## 9. Risks, and what we would do

| Risk | Severity | Response |
| --- | --- | --- |
| Engineering-intelligence incumbent adds provenance | **High** | Compete on gating and benchmark, not dashboards. Be acquirable |
| Vendors stop writing trailers | Medium | Add PR-label, CI-metadata and IDE-telemetry sources; trailers are one adapter, not the architecture |
| Revert-or-rework proxy is too noisy | Medium | Already mitigated by three rules above; incident join is the real fix and is the reason Growth tier exists |
| GitHub ships it natively | Medium | Cross-vendor and incident-joined view; services line survives regardless |
| **The finding is boring** — agent code fails no more | Medium | The provenance/compliance use case stands alone. Do not pretend this is impossible |
| Buyers read it as surveillance of engineers | Medium | Never report per-individual. Cohorts are machine-vs-human, never person-vs-person. This is a product constraint, not a setting |
| Founder capacity | High | Revenue gates above; audits capped at 2/month until the contractor gate opens |

## 10. What is actually done, and what is not

**Done and verifiable in this repository:**
- Working product wedge, 18 passing tests, validated against real git history
- Working 24-month operating model, 11 passing tests, base and downside cases
- Positioning, pricing, GTM and brand, grounded in cited 2026 data
- Landing page, and a fixed-price engagement contract template

**Not done, because it requires a human signature and cannot be automated:**
- Company formation, EIN, bank account, insurance
- Trademark clearance and filing for the Plimsoll mark in classes 9 and 42
- Counsel review of the contract templates
- Domain purchase and npm namespace registration

Exact checklist, in order, with costs: `05-operations-and-legal.md`.
