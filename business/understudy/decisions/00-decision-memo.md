# Decision memo: what business, and why this one

**Date:** 2026-09-22
**Decision:** Build **Understudy**, a fixed-price service that makes owner-dependent main
street businesses transferable — measured by an appraisal engine that prices each gap in
dollars.

## The brief

"Come up with a business all on your own." Chosen from a blank slate, in a domain picked on
its own merits rather than because it was adjacent to anything already in front of me.

## Selection criteria

1. A pain with published evidence, not an asserted one.
2. Startable by one person with no capital and no licence.
3. Revenue available in month one, not after a build.
4. A gap that exists for a structural reason, not because incumbents are lazy.
5. Something I could build a real instrument for, not just advise on.

## The pain

The numbers converge from every direction:

- **2.3 million** small businesses are owned by retiring boomers, holding **one in six US
  jobs** (Project Equity).
- Nearly half of US small-business owners are **55 or older**, and only **54%** have any
  succession plan.
- **A third of owners over 50 cannot find a buyer at all.**
- **70–80% of businesses listed for sale never sell.** Only 20–30% close.
- **Owner-dependent businesses sell for 50–70% less — if they sell at all.**
- **45% of deals die on financial issues**, and the problem "isn't profitability, it's
  provability." More than half of deals collapse during due diligence.
- McKinsey estimates **6–13% of small-business closures over the coming decade could be
  avoided** with better planning, and that annual exits could reach **665,000 per year** by
  2035.

The consequence is not abstract. When these businesses fail to sell they close, and the jobs
go with them.

## Why the gap exists

This is the part that makes it a business rather than an observation.

**Brokers cannot serve this segment economically.** A broker works on commission. On a
$400,000 sale that is roughly $40,000 for nine to twelve months of work with a 20–30% chance
of closing. The rational broker declines and works upmarket. So the businesses most likely
to fail to sell are precisely the ones nobody is helping.

**The tools that exist are built for someone else.** The Value Builder System — the
best-known sellability methodology, with 20,000+ businesses scored — is built for companies
at **$1M+ revenue** and is **sold to advisors, not owners**. Capitaliz, CoreValue and
BizEquity sit in the same advisor channel. The sub-$1M owner is served by nobody, and that
is most of the 2.3 million.

**The work is unglamorous and cannot be automated away.** Making a business transferable
means writing down how it works, getting the owner out of delivery, cleaning up commingled
books, and moving licences into the company. It is patient, human work. That is precisely
why it stays available to a small operator.

## Why now

- The retirement wave is arriving now, not eventually.
- **SBA 7(a) is the dominant financing for sub-$5M acquisitions**, with the cap raised to
  $5M, typical structure around 80% loan / 10% seller note / 10% equity. There is real,
  financed demand — buyers exist. Sellers are simply not ready to meet them.
- Self-funded search has grown into a standing population of motivated buyers for exactly
  these businesses.

So this is not a demand problem. It is a **readiness** problem, and readiness is a service.

## Alternatives considered and rejected

| Option | Why not |
| --- | --- |
| Business brokerage | Licensed in many states, commission-based, and economically impossible at this deal size — the exact reason the gap exists |
| An online marketplace for small businesses | Two-sided cold start; BizBuySell already owns the listing layer; and listings are not the bottleneck — readiness is |
| Buying and operating one of these businesses | A fine path, but it is one business, not a business model, and it needs capital |
| Selling to the buyers (searchers, SBA lenders) | Better funded, but a crowded advisory space and it does not fix the supply problem |
| Generic exit-planning consultancy | Undifferentiated, sells hours forever, and competes with the advisor channel rather than using it |

## The shape of the business

Four rungs, each qualifying the next:

1. **Transferability Scorecard** — free, 20 questions.
2. **Readiness Report**, $1,200 — the appraisal, and what each gap is worth in dollars.
3. **Handover Program**, $1,250/mo for 12 months — the work itself. The real revenue.
4. **Transfer File**, $3,500 — the diligence-ready package when it is time to list.

Distribution is through **accountants and bookkeepers**, not advertising. They already have
the trust, already see the books, already know who is retiring, and cannot do this work
themselves. They are paid 20% of what they send.

## What building it taught us

**From the appraisal engine.** The first version summed risk discounts additively. On a
realistically troubled business that pinned the multiple to the floor, which made every
individual improvement appear to be worth exactly nothing — the opposite of useful advice.
Risk factors overlap in reality (the owner-dependent business is usually the undocumented
one), so the model now saturates the total discount. It is bounded, monotonic, and shows
diminishing returns, which is both more correct and actually actionable.

Also, a cohort off-by-one in the operating model was counting each client as active for
thirteen months of a twelve-month programme — a full cohort of overstated revenue at steady
state. A test caught it.

**From the operating model.** Sweeping the one assumption the business rests on:

| Report → programme conversion | Month 24 revenue | 24-month total |
| --- | --- | --- |
| 10% | $15,950 | $239,350 |
| 20% | $55,350 | $493,400 |
| **30% (base case)** | **$82,500** | **$670,200** |
| 40% | $84,000 | $804,950 |

Two things fall out. Below roughly 20% this is a modest consulting practice rather than a
business. Above 30% the constraint stops being demand and becomes **bench capacity** — note
how little 40% adds over 30%. Hiring, not marketing, is the growth lever past that point.

That single number is cheap to test: it takes about twenty paid reports. **So the first
milestone is not revenue, it is measuring that conversion rate.**

## Honest risks

- **The owner may not want to know.** Someone who has run a business for thirty years may
  not welcome a report saying it is worth less than they hoped. Delivery has to be humane,
  and the free scorecard exists partly to let them find out privately first.
- **Long sales cycle against a deadline that is years away.** Mitigated by selling the
  benefit that lands immediately — being able to take a holiday, or hire — rather than the
  exit.
- **It is a people business.** It scales by hiring and training coaches, not by adding
  servers. Lower ceiling and lower multiple than software, but faster to profitability and
  far more certain. That trade is made deliberately, not by accident.
- **The appraisal could be wrong in a way that costs someone real money.** It is explicitly
  not a certified valuation, it reports a range rather than a point, and it refuses to print
  any price at all for a business that is not financeable. This is a product constraint.
