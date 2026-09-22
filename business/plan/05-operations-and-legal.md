# Operations and legal

## The honest boundary

Everything in this repository that can be produced without a legal signature has been
produced. The items below cannot be: they require a human identity, a signature, or a
payment method. They are listed in dependency order with real costs so they can be executed
in an afternoon.

**Nothing here is legal or tax advice.** The templates are drafting starting points for a
lawyer to review, not substitutes for one.

## Formation checklist

Assumes a US-based single founder. Adapt for other jurisdictions.

| # | Step | Cost | Depends on | Notes |
| --- | --- | --- | --- | --- |
| 1 | **Trademark clearance search** for "Plimsoll" in Nice classes 9 (software) and 42 (SaaS) | $0–400 | — | **Do this first.** A UK entity, Plimsoll Productions Ltd, holds marks in entertainment classes; that is likely not a bar in 9/42, but it must be cleared by counsel before anything is printed |
| 2 | Register domain | ~$15/yr | 1 | `plimsoll.dev` or `getplimsoll.com`. Buy both |
| 3 | Reserve npm scope `@plimsoll` | $0 | 1 | Do it the same hour as the domain |
| 4 | Form the entity | $300–800 | 1 | Delaware LLC for simplicity; Delaware C-Corp only if outside investment is genuinely intended. This plan does not require any |
| 5 | Registered agent | ~$120/yr | 4 | Bundled by most formation services |
| 6 | EIN from the IRS | $0 | 4 | Free and online. Never pay a service for this |
| 7 | Business bank account | $0 | 6 | Mercury or Relay for a software business |
| 8 | Accounting | ~$30/mo | 7 | Set it up before the first invoice, not after |
| 9 | Stripe or Paddle | rev share | 7 | Paddle acts as merchant of record and handles global VAT/sales tax — worth the higher rate for a solo operator selling internationally |
| 10 | Professional liability (E&O) insurance | ~$60–150/mo | 4 | Required by most mid-market customers before signing. Get it before the first audit, not when asked |
| 11 | Counsel review of MSA, SOW, DPA | $1,500–3,000 | 4 | One-time. The templates here reduce the hours, they do not remove them |
| 12 | Trademark filing | $250–350/class + counsel | 1 | After first revenue, not before |

**Total to be operational: roughly $1,200 plus insurance.** This is reflected as
`formationOneOff` in the operating model.

## Security and data posture

This is a product sold on trust to buyers who will ask hard questions. The posture is a
feature and should be designed now rather than retrofitted.

**Principles**

1. **The free report never transmits anything.** It runs locally and prints to stdout. This
   is architectural, not a setting, and it is why a security-sensitive buyer will run it in
   week one.
2. **Metadata only, never source.** Cloud ingests commit SHAs, timestamps, file paths,
   trailer identities, line counts, CI outcomes. It does **not** ingest diffs or file
   contents. There is no product reason to and every reason not to.
3. **Read-only scopes.** The GitHub App requests read access to metadata, contents (for
   history), pull requests, checks and deployments. It never requests write access until
   merge-gating is shipped, and that is a separate, explicitly granted scope.
4. **Never report on individuals.** Cohorts are machine-versus-human. The product must not
   be usable to rank named engineers by AI usage, and per-individual reporting is not a
   feature to be added later. It is the fastest way to be banned by the buyer's own team,
   and it is the wrong thing to build.
5. **Deletion on request, verified.** Full purge within 30 days, confirmable.

**Compliance sequence:** self-assessed security questionnaire answers (month 1) → DPA
template and subprocessor list (month 4) → SOC 2 Type I when a deal requires it, not before
(realistically month 12–18, ~$15–25k). Do not buy SOC 2 speculatively; it is the single most
common premature expense for a business at this stage.

## Delivery operations

**Audit runbook** (the engagement must be repeatable by month 6, not heroic):

1. **Day 0** — signed SOW, read-only GitHub App installed, incident data source identified
   (PagerDuty, Incident.io, Jira, or a CSV export — accept whatever exists).
2. **Days 1–3** — run the report across all repos; join to deploys, CI and incidents;
   identify cohorts and the highest-risk paths.
3. **Days 4–6** — interviews with 3–5 engineers. This is non-negotiable and is where the
   finding becomes explicable rather than merely true.
4. **Days 7–9** — draft findings, per-service breakdown, proposed merge policy.
5. **Day 10** — readout to the engineering leader and their staff. Deliver the configured
   policy as a pull request against their repo, not as a recommendation in a slide.
6. **Day 60** — re-measure and send a one-page delta. This is what converts an audit into a
   subscription, and it should be in the SOW as included work.

**Capacity:** 2 audits/month solo. 4 with the first contractor. This is the binding
constraint on services revenue and it is modelled as such — audits are capped by capacity in
the model no matter how large the funnel gets.

## Hiring plan

Deliberately minimal, and gated on revenue rather than the calendar.

| Role | Trigger | Why |
| --- | --- | --- |
| Contractor engineer (part-time) | Trailing-3-month revenue > $25k/mo | Doubles audit capacity; takes over report maintenance |
| Customer engineer | 25 Cloud customers | Onboarding and audit delivery |
| Second engineer | $40k MRR | Merge-gating and the benchmark |

No sales hire in the first 24 months. The motion is content plus founder-led sales, and
hiring sales before the motion is proven is how this kind of business dies.

## Cadence

- **Weekly:** pipeline review, one published artefact, report-run count.
- **Monthly:** re-run the operating model against actual numbers. The model is a living
  document — when reality diverges, change `assumptions.json` and re-read the output rather
  than defending the original.
- **Quarterly:** check the three stop conditions in `04-go-to-market.md` honestly.
