# Market and competition

## The evidence base

Every number here is from a published 2026 source and is cited. Where a figure is an
estimate of ours, it says so.

### Adoption is effectively complete

| Metric | Value | Source |
| --- | --- | --- |
| Developers regularly using AI coding tools | 85% | 2026 developer surveys |
| Share of committed code written by AI | ~42% | Sonar, 2026 State of Code |
| Enterprise apps shipped/updated in Q1 2026 embedding an agent | 80% (up from 33% in 2024) | Enterprise adoption trackers |
| Professional developers using AI tools daily | 51% | 2026 developer surveys |

### Quality moved the other way

| Metric | Change | Source |
| --- | --- | --- |
| Incidents per pull request | +23.5% YoY | Cortex, *Engineering in the Age of AI: 2026* |
| Change failure rate | ~+30% | Cortex, 2026 |
| Issues in AI co-authored PRs | 1.7× human-only | CodeRabbit |
| Vulnerabilities in AI-written code | 2.74× | Veracode 2026 GenAI Code Security |
| AI codegen tasks introducing a risky vulnerability | ~44% | Veracode 2026 |
| Refactored share of changed lines | 25% → 3.8% | GitClear, 623M changes |
| Duplicated lines | 8.3% → 15.7% | GitClear |
| Error-masking constructs | +47% | GitClear |
| Major incidents across 15 studied platforms | 238 → 310/yr | Industry incident study |

### Trust is the gap being felt

- **96%** of developers do not fully trust AI-generated code.
- Only **48%** always verify it before committing.
- Only **29%** trust the tools they use daily.

That combination — mandatory adoption, measurably worse outcomes, low trust, no local
evidence — is the market. Teams are being asked to accept a risk they cannot size.

## Sizing

Bottom-up, and deliberately conservative.

- Companies worldwide with ≥20 engineers and a git-hosted codebase: **~150,000** (estimate).
- Of those, using agentic coding tools that write trailers today: **~60%** → **90,000**.
- Reachable serviceable market (English-speaking, self-serve or mid-market motion,
  security/compliance pressure): **~15,000** (our estimate).
- At a $6,000 blended annual contract value: **SAM ≈ $90M**.

This is not a billion-dollar TAM slide and should not pretend to be. It is a market where a
single operator can reach $1M ARR against **0.2%** penetration of the serviceable market —
about 165 customers. That is the only number that matters at this stage.

## Competitive map

### Category 1 — AI code review (adjacent, not overlapping)

| Vendor | Price | Unit of analysis |
| --- | --- | --- |
| CodeRabbit | $24–30/dev/mo | One PR, pre-merge |
| Greptile | $30/seat/mo (50 reviews) | One PR, pre-merge |
| Qodo | ~$30/dev/mo | One PR, pre-merge |
| Graphite | $40/dev/mo (Team) | One PR, pre-merge |
| CodeAnt | ~$24/dev/mo | One PR, pre-merge |

**Why they do not close the gap.** These tools find issues in *a* change. They do not
produce a rate, cannot compare cohorts, and have no memory of what happened after merge.
Ask any of them "is our agent-written code failing more than our human-written code, and is
that trend improving?" and there is no answer in the product. CodeRabbit publishes the 1.7×
figure as marketing — across *their* corpus, not yours.

Notably, they are also a **distribution channel and a reference point**, not only rivals:
Plimsoll measures whether the gates a team already bought are working.

### Category 2 — AI agent observability (adjacent, not overlapping)

Braintrust ($80M Series B, $800M valuation, Feb 2026), Langfuse, LangSmith, Arize
Phoenix/AX, Helicone, Laminar, Maxim, Datadog LLM Observability. Cisco announced intent to
acquire Galileo in April 2026.

**Why they do not close the gap.** Their unit is an LLM span inside a product you ship.
Their buyer is the team building an AI feature. A company with zero AI features but whose
engineers use Claude Code all day is invisible to every one of them. Different data,
different buyer, different question.

### Category 3 — Engineering intelligence (the real competitor)

LinearB, Jellyfish, Swarmia, Cortex, DX. These own the "engineering metrics" budget line
and Cortex is publishing exactly the benchmark data quoted above.

**This is the credible threat**, and it deserves a straight answer rather than a dismissal.
Any of them could add a provenance dimension to their existing DORA dashboards.

Three things make that slower than it looks:

1. **They are seat-priced, top-down sales motions** with 6–12 week procurement. Plimsoll's
   wedge is a local CLI a staff engineer runs in 30 seconds without asking anyone.
2. **Their data model is people-centric** — teams, individuals, sprints. Provenance cuts
   across it and forces an uncomfortable product question they have institutional reasons
   to avoid: their buyers do not want a tool that appears to rank engineers by AI usage.
3. **They monitor; they do not gate.** The second half of Plimsoll is a merge-time policy
   ("agent-authored changes touching payments require two human reviewers"), which is a
   different surface entirely.

The honest position: **this is a 12–24 month window, not a durable moat.** The plan is to
use it to get to incident-joined data and policy enforcement, which are far stickier than
a dashboard, and to be an acquisition target for exactly this category if that fails.

## Why now

1. Trailers became near-universal in agentic tools during 2025–26, making attribution free.
2. The quality data turned from anecdote into published benchmarks in 2026, so the buyer
   now has a reason to look.
3. EU AI Act and procurement questionnaires are starting to ask about AI provenance in
   software supply chains, which converts a nice-to-have into an audit artefact.

## Sources

- [Cortex — Engineering in the Age of AI: 2026 Benchmark](https://www.pagerly.io/blog/ai-generated-code-incidents-2026-data-2026-08-30)
- [Veracode 2026 GenAI Code Security Report (summarised)](https://www.kusari.dev/blog/ai-coding-assistants-in-2026-4x-faster-10x-riskier-the-hidden-security-cost)
- [GitClear code-quality analysis, 623M changes](https://www.secondtalent.com/resources/ai-generated-code-quality-metrics-and-statistics-for-2026/)
- [AI code review tool pricing comparison, 2026](https://tech-insider.org/coderabbit-vs-greptile-vs-qodo-2026/)
- [AI agent observability landscape, 2026](https://latitude.so/blog/15-ai-agent-observability-platforms-2026-agentic-complexity)
- [AI coding agent adoption statistics, 2026](https://fungies.io/ai-coding-agent-adoption-statistics-2026/)
- [AI-generated code security risks](https://www.qasource.com/blog/ai-generated-code-security-risks)
