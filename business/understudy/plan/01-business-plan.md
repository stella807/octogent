# Understudy — business plan

> An understudy is the person who learns the part so the show can go on without the lead.

## 1. The one-line version

**Understudy makes an owner-dependent business transferable — so it can be sold, financed,
or simply run without the owner in it — and prices every gap in dollars so the owner knows
what the work is worth before they do it.**

## 2. The problem

2.3 million American small businesses are owned by people heading into retirement. They hold
**one in six US jobs**. Nearly half of all small-business owners are 55 or older, and only
54% have a succession plan.

Between **70% and 80% of businesses listed for sale never find a buyer.** A third of owners
over 50 cannot find one at all. Among the deals that do start, more than half collapse in
due diligence, and about 45% die on financial issues — where the problem, as the research
puts it, "isn't profitability, it's **provability**."

And the single largest discount is structural: **owner-dependent businesses sell for 50–70%
less, if they sell at all.**

When these businesses fail to sell, they close. The jobs go with them. McKinsey estimates
**6–13% of closures over the coming decade are avoidable** with better preparation.

## 3. The insight

**This is not a demand problem. It is a readiness problem.**

Buyers exist and are financed. SBA 7(a) is the dominant vehicle for sub-$5M acquisitions,
the cap is now $5M, the structure is roughly 80% loan / 10% seller note / 10% equity, and
self-funded search has created a standing population of motivated buyers.

What does not exist is a supply of businesses in a condition to be bought. The owner is the
business: they hold the customer relationships, do the work, keep the process in their head,
hold the licences in their own name, and run personal spending through the books. Every one
of those is a discount, and together they are usually disqualifying.

Readiness is fixable, on a schedule, for money. **That is a service, and nobody is selling
it to this segment.**

## 4. Why the gap exists

Two structural reasons, neither of which is "the incumbents haven't noticed."

**Brokers cannot serve this segment.** A broker earns roughly $40,000 on a $400,000 sale, for
nine to twelve months of work, at a 20–30% close rate. The rational broker works upmarket. So
the businesses least likely to sell are exactly the ones with nobody helping them.

**The tools are built for someone else.** Value Builder — the best-known sellability
methodology, 20,000+ businesses scored, and whose own research shows an 80+ score sells at a
**71% premium** — is built for **$1M+ revenue** and sold **to advisors, not owners**.
Capitaliz, CoreValue and BizEquity sit in the same channel. Moving downmarket would undercut
the advisors they sell through. And a score is not a work order: a $200k-SDE owner does not
need an index, they need three things to do in order and what each is worth.

## 5. Product

| Rung | What it is | Price | Status |
| --- | --- | --- | --- |
| **Transferability Scorecard** | 20 questions, instant result | Free | Design complete |
| **Readiness Report** | Full appraisal: what it would fetch, what each gap is worth, in what order | **$1,200** | **Engine built.** 43 tests |
| **Handover Program** | The work itself, over 12 months, with a coach | **$1,250/mo** | Deliverable by hand from day one |
| **Transfer File** | The diligence-ready package when it is time to list | **$3,500** | Templates drafted |

### What the appraisal engine does

Given a business profile it computes:

1. **Seller's discretionary earnings**, with every add-back itemised — because in diligence
   each one is argued individually, and anything undocumented is struck out. It flags when
   add-backs exceed net profit, which is when buyers stop believing the earnings.
2. **A base multiple** from earnings size and trade, calibrated to 2026 closed-transaction
   data (2.6–2.7× average; 2.5–3.5× at $250–500k SDE; 3–4× home services).
3. **A risk-adjusted multiple**, scoring the seven things buyers and SBA lenders actually
   interrogate: owner dependence, provable financials, customer concentration, recurring
   revenue, documented operations, team continuity, transferable rights.
4. **A dollar value for closing each gap**, ranked by value earned per month of effort.
5. **A verdict** — and for a business with commingled cash books, that verdict is **not
   listable at any multiple**, with no price shown at all.

That last point is the product's spine. More than half of deals die in diligence; printing a
hopeful asking price for a business no lender will finance is the most harmful thing this
tool could do. It refuses.

### Worked example

A representative HVAC business: $1.85M revenue, $302k SDE after add-backs, owner working 58
hours a week in the van, no second-in-command, no documented process, licences in his own
name, tax returns only.

```
WHAT IT WOULD FETCH TODAY
  $453,000 – $664,400
  midpoint $558,700 at 1.85× SDE (3.5× base for this size and trade, risk-adjusted down)

WHAT EACH GAP IS WORTH             value  months  effort   per month
Owner dependence                $135,900      12     ●●●     $11,325
Documented operations            $54,360       6     ●○○      $9,060
Provable financials              $45,300       6     ●●○      $7,550
Transferable rights              $51,340       9     ●●○      $5,704
Recurring revenue                $33,220      12     ●●○      $2,768
Team continuity                  $18,120      12     ●●○      $1,510

IF YOU CLOSED ALL OF THEM
  $558,700  →  $1,307,660    (+$748,960, 4.33× SDE)
```

The implied discount for being owner-dependent — 1.85× against 4.33× — is **57%**, which
sits squarely inside the 50–70% the market data reports. The model was calibrated
independently of that figure and landing there is a useful check on it.

That is the sales conversation: **$15,000 of programme fees against roughly $749,000 of
enterprise value, over about a year.**

## 6. Market

- **SAM ≈ $1.1B** across the retirement wave, ~$114M/year over a decade (our estimate;
  derivation in `02-market-and-competition.md`).
- **$1M of annual revenue needs about 175 customers out of ~200,000** — 0.09% of the
  serviceable market. That is the only penetration figure this plan depends on.

## 7. Business model, and its honest ceiling

Delivery is done by people. The binding constraint is the coaching bench, not servers, and
the Handover Program is a fixed twelve-month engagement — clients **graduate**, they do not
churn indefinitely. The revenue line is a rolling book of cohorts.

This is a deliberate trade, made with open eyes:

| | Understudy | A software business |
| --- | --- | --- |
| Time to profitability | Month 1 | Usually years |
| Capital required | None | Often significant |
| Gross margin | ~60% at scale | ~80–90% |
| Scaling lever | Hiring and training coaches | Shipping code |
| Realistic ceiling | Tens of millions | Larger |

Lower ceiling, lower multiple, far more certain, and profitable almost immediately. For a
single operator with no capital that is the right side of the trade.

## 8. Financial plan

From the runnable model (`node business/understudy/model/run.mjs`):

**Base case**

| | |
| --- | --- |
| First profitable month | **1** |
| Deepest cash trough | **−$916** |
| Month 24 revenue | **$82,500/mo** (~$990k run rate) |
| Active programmes at month 24 | 44 across 4 coaches |
| Total revenue, 24 months | $670,200 |
| Outside capital required | **None** |

A $7,000/mo founder draw from month 7 and coach salaries are both costed.

**The sensitivity that matters.** Sweeping the one assumption the business rests on — whether
a paid report converts into a programme:

| Report → programme | Month 24 revenue | 24-month total |
| --- | --- | --- |
| 10% | $15,950 | $239,350 |
| 20% | $55,350 | $493,400 |
| **30% (base)** | **$82,500** | **$670,200** |
| 40% | $84,000 | $804,950 |

Two conclusions, and they set the whole operating plan:

1. **Below ~20%, this is a modest consulting practice, not a business.**
2. **Above ~30%, the constraint stops being demand and becomes bench capacity** — note how
   little 40% adds over 30%. Past that point the growth lever is hiring, not marketing.

**Therefore the first milestone is not revenue. It is measuring that conversion rate**, which
takes roughly twenty paid reports and can be done inside 90 days.

**Downside case** — partner recruitment halved, conversions cut by roughly half:

| | Founder draw on schedule | Draw deferred and reduced |
| --- | --- | --- |
| Deepest cash trough | **−$79,436** | **−$6,473** |
| First profitable month | 5 | 5 |

Operating revenue holds up; what creates the hole is paying the founder on a calendar rather
than on results. Hard gates, adopted as policy:

- **No founder draw** until trailing-three-month revenue exceeds $12,000/mo.
- **No coach hired** until the existing bench is 80% full. The model enforces this.
- **No paid advertising** in year one. The channel is referral.

## 9. Go to market

Through **accountants and bookkeepers**, paid 20% of what they refer. They have the trust,
see the books, know who is retiring, and cannot do this work themselves. This is the single
most important strategic choice in the plan; the alternative — advertising to 60-year-old
plumbing-company owners — is slow and expensive. Detail in `04-go-to-market.md`.

## 10. Risks

| Risk | Severity | Response |
| --- | --- | --- |
| Report → programme conversion below 20% | **High** | Test it first, in 90 days, with 20 reports. It is cheap to falsify and everything depends on it |
| Owner does not want to hear the number | High | Free private scorecard first; humane delivery; lead with benefits that land now, not at exit |
| Long sales cycle against a distant deadline | Medium | Sell the holiday and the hire, not the exit |
| Coach quality dilutes delivery | Medium | Documented methodology is literally the product we sell; apply it to ourselves first |
| Value Builder moves downmarket | Low–Medium | Their advisor channel prevents it; if it happens, compete on doing the work rather than scoring it |
| Appraisal is wrong and costs someone money | **High** | Not a certified valuation; ranges not points; refuses to price an unfinanceable business; disclosed in every report |
| Mistaken for a broker | Medium | We never broker, never take a success fee on a sale, and say so in the engagement letter. This is also the licensing boundary |

## 11. What is done, and what is not

**Done and verifiable here:**
- Working appraisal engine, 43 passing tests, with a worked example
- Working 24-month operating model, 13 passing tests, base case plus sensitivity sweep
- Positioning, sizing, pricing, GTM, operations and brand, grounded in cited sources
- Landing page and a fixed-price engagement letter

**Not done, because it needs a human signature:**
- Entity formation, EIN, bank account, professional liability insurance
- A state-by-state check that the scope stays clear of business-brokerage licensing
- Counsel review of the engagement letter
- Trademark clearance for the Understudy mark
- Domain purchase

Costed checklist in `05-operations-and-legal.md`.
