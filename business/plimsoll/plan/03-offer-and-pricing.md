# Offer and pricing

## The ladder

Three rungs. Each one is independently useful, and each one qualifies the buyer for the next.

### 1. The Load Line Report — free, local, no signup

```bash
npx @plimsoll/report --since "12 months ago"
```

Runs `git log` locally and prints: agent-authored share of merged lines, revert and rework
rates for the agent and human cohorts, and the ratio between them.

**Why free and why local.** The buyer's first reaction to any tool in this category is "you
are not putting my proprietary code in your cloud." The report never sends anything
anywhere, which removes security review from the first interaction entirely. It is also
genuinely useful standalone — that is the point, not a growth tactic. A wedge that is not
useful on its own does not get run twice.

**What it is not.** It cannot see pull requests, CI outcomes, incidents, or reviewer
behaviour, and it says so in its own output. That limitation is the upgrade path.

### 2. The Load Line Audit — $7,500, fixed price, two weeks

A human engagement. We connect to GitHub and CI, join the provenance cohorts to real
incident and deploy data, and deliver:

- A board-ready read on agent-authored change failure rate versus the human baseline
- Per-service and per-team breakdown, so the finding is actionable rather than a headline
- The three highest-risk paths where agent-authored changes concentrate
- A configured merge policy (CODEOWNERS, required reviewers, CI gates) for those paths
- A 60-day re-measurement to show whether the policy moved the number

**Why fixed price.** Hourly billing punishes us for the tooling getting better, which is
exactly backwards. Fixed price at $7,500 is below the signature threshold that triggers
procurement at most mid-market companies — a VP Eng can approve it out of a discretionary
budget in one meeting.

**Why it exists at all.** Two reasons, in order of importance: it is the only thing
generating cash in months 1–9, and it is the product discovery channel. Every audit teaches
us what the subscription must do. The first ten are worth more as research than as revenue.

### 3. Plimsoll Cloud — $499 / $1,500 / custom per month

| Plan | Price | For |
| --- | --- | --- |
| **Team** | $499/mo | Up to 25 engineers, 10 repos. Continuous load line, weekly digest, Slack alerts |
| **Growth** | $1,500/mo | Up to 150 engineers, unlimited repos. Incident joins, per-service thresholds, merge-time policy gates, SSO |
| **Enterprise** | Custom (from $3,000/mo) | Self-hosted or VPC, audit export, EU AI Act provenance attestation, SLA |

## Why not per-seat

Every competitor prices per developer per month ($12–40). Plimsoll deliberately does not,
for three reasons:

1. **The buyer is different.** Per-seat tools come out of the tooling budget and are
   justified per-developer. Plimsoll is bought by an engineering leader out of a
   platform/quality budget and justified per-incident-avoided.
2. **Per-seat punishes the outcome we sell.** A team that adopts agents heavily has *more*
   need of a load line and *fewer* humans per unit of output. Charging per human means
   revenue falls exactly as the problem grows. That is an incoherent price.
3. **It avoids a losing comparison.** At $30/dev a 40-person team pays $1,200/mo for
   CodeRabbit. Priced per-seat, Plimsoll is "another $30 line item" competing for the same
   budget. Priced per-org at $499, it is a rounding error next to the review tool it audits.

Repo and engineer ceilings exist to create upgrade pressure, not to meter usage. Nobody is
ever billed a surprise.

## Blended economics

From the operating model (`business/plimsoll/model/`):

- **Blended ARPU:** $699/mo (80% Team, 20% Growth)
- **Gross margin on subscription:** ~98% ($12/customer/mo infrastructure)
- **Gross margin on audit:** ~95% excluding founder time; ~45% once founder time is costed
  at the contractor rate. Audits are a cash and learning engine, not a margin engine
- **Target CAC:** under $1,200, effectively all content and community time in year one
- **LTV at 3% monthly churn:** ~33 months × $699 ≈ **$23,000**

The LTV:CAC ratio here is not the interesting number — at these volumes it is noise. The
interesting number is the cash trough, below.

## Price changes we expect to make

Stating these now so they are decisions rather than drift:

- The $7,500 audit is **underpriced** if it reliably finds a real risk concentration.
  Expect $12,000–15,000 by month 12 once there are three named references.
- Team at $499 is a **land price**, chosen to be approvable without a purchase order.
  It will not rise for existing customers; new-customer pricing is expected to move to
  $699 once the incident-join feature ships.
- Enterprise floor rises with every compliance feature shipped. EU AI Act provenance
  attestation alone justifies $3,000/mo to a regulated buyer.
