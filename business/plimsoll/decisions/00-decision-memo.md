# Decision memo: what business, and why this one

**Date:** 2026-09-22
**Decision:** Build **Plimsoll**, a measurement and gating product for agent-authored code,
sold first as a fixed-price audit and then as a subscription.

## The brief

"Create a business fully on your own." No sector, no capital constraint, no customer given.
So the choice itself is the first deliverable, and it should be defended rather than assumed.

## Selection criteria

A business worth choosing here had to clear five bars:

1. **A pain that is measurable, not asserted.** Something with public evidence behind it.
2. **Buildable by one operator.** No capital, no licences, no inventory, no sales team.
3. **A wedge that ships in weeks.** Something usable before anything is charged for.
4. **A real reason it is not already solved.** Not "the incumbents are lazy."
5. **A revenue line available immediately,** so the product is not funded on hope.

## The pain

The 2026 data is unusually unambiguous, and it points the same way from several directions:

- AI now writes roughly **42% of committed code** (Sonar, 2026 State of Code).
- **96% of developers do not fully trust** AI-generated code; only 48% always verify it.
- Incidents per pull request are up **23.5%** and change failure rate up **~30%** year over
  year (Cortex, *Engineering in the Age of AI: 2026 Benchmark*).
- AI co-authored PRs contain **1.7× more issues** (CodeRabbit) and **2.74× more
  vulnerabilities**; models pass security checks **56%** of the time (Veracode, 2026).
- Across 623M analysed changes, refactoring collapsed from 25% to 3.8% of changed lines,
  duplication rose 81%, and error-masking rose 47% (GitClear).

Read together: adoption is effectively total, quality is measurably worse, and *nobody
knows their own numbers*. Every figure above is an industry aggregate. No engineering
leader can currently answer "what is it doing to **us**?"

## Why it is not already solved

Two adjacent categories look like they cover this and do not:

- **AI code review** (CodeRabbit, Greptile, Qodo, Graphite, $12–40/dev/mo) reviews a single
  pull request in isolation, before merge. It cannot tell you a rate, a trend, or whether
  the agent cohort is worse than the human one. It is a spell-checker, not a scale.
- **AI agent observability** (Braintrust, Langfuse, LangSmith, Arize, Datadog) traces LLM
  calls inside *AI products you ship*. Its unit is a span; its buyer is the team building
  an AI feature. It has nothing to say about your own repository being written by agents.

The gap is a third thing: **provenance-sliced delivery metrics on your own codebase.**
Different unit (the merged change), different buyer (VP Eng / platform), different data
(git, PRs, CI, incidents — not model traces).

## Why it is buildable now

The enabling detail is mundane and decisive: **agentic coding tools already stamp
`Co-Authored-By` trailers by default, and trailers survive rebase.** Attribution does not
need to be instrumented, negotiated, or retrofitted — it is already sitting in the history
of every repository that uses these tools. A useful first report needs nothing but
`git log`, which also means it runs locally and no customer code has to leave the machine.

That was verified, not assumed: the CLI in `product/plimsoll/` was built and run against
this repository's real history before any of this plan was written.

## Alternatives considered and rejected

| Option | Why not |
| --- | --- |
| Another AI code review bot | Four funded incumbents, commodity pricing, no wedge |
| LLM observability platform | Braintrust raised $80M at $800M in Feb 2026; Cisco bought Galileo. Wrong fight |
| Hosted Octogent (this repo's tool) | Built on someone else's MIT project; thin moat, and the orchestration market is being absorbed by the model vendors |
| Generic "AI consultancy" | No asset, no compounding, sells hours forever |
| Crypto/quant product (per `quant-bot/`) | Regulated, adversarial, and the repo's own research concluded the strategies fail walk-forward |

## The shape of the business

Three layers, each funding the next:

1. **Free local report** (built) — acquisition. Honest standalone value, zero trust barrier.
2. **Load Line Audit**, $7,500 fixed price — near-term cash, and the discovery channel that
   tells us what the product must do.
3. **Plimsoll Cloud**, $499–$1,500/mo — the compounding line.

## What the model taught us

Running the operating model at downside assumptions surfaced the single most important
operating rule, which was not obvious beforehand:

> **Calendar-gated spending kills this business; revenue-gated spending does not.**

With the contractor hired in month 10 and a founder draw from month 7 regardless of
traction, the downside case never turns profitable and bottoms out at **−$180,549**. Gate
both on trailing revenue instead and the *same* downside assumptions produce a **−$12,498**
trough, profitability in month 9, and a positive cash balance at month 24.

The business is not fragile to demand being half of what we hope. It is fragile to spending
as though it were not.

## Honest risks

- **Proxy risk.** Revert-or-rework is a proxy for change failure. It must be joined to real
  incident data before anyone runs a policy off it, and the tool says so in its own output.
- **Attribution decay.** If vendors stop writing trailers, the free wedge degrades. Mitigated
  by also supporting PR-label and CI-metadata sources.
- **Platform risk.** GitHub could ship provenance analytics natively. This is real. The
  counter is the cross-vendor, incident-joined view a platform is slow to build — and that
  the services line is valuable regardless.
- **The number may be boring.** If agent-authored code turns out to fail no more often, the
  risk product weakens. The provenance and compliance use case survives; the plan should not
  pretend this outcome is impossible.
