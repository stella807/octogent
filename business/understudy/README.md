# Understudy

**A business that cannot run without you is not a business. It is a job you cannot quit —
and cannot sell.**

2.3 million American small businesses are owned by people heading for retirement. They hold
one in six US jobs. Between 70% and 80% of the ones that go up for sale never find a buyer,
and owner-dependent businesses that do sell fetch 50–70% less. Understudy makes a business
transferable — so it can be sold, financed, or simply run without the owner in it.

The name is the product: an understudy is the person who learns the part so the show can go
on without the lead.

## Status

| Piece | State |
| --- | --- |
| Appraisal engine (`appraise`) | **Working.** 43 passing tests, runs on a business profile |
| Operating model | **Working.** 13 passing tests, 24-month projection |
| Positioning, pricing, GTM, brand | Written, grounded in cited 2026 sources |
| Entity, licensing check, counsel review | **Blocked — requires a human signature.** See `plan/05` |

## Contents

- `decisions/00-decision-memo.md` — what business, why this one, what was rejected
- `plan/01-business-plan.md` — the whole thing in one document
- `plan/02-market-and-competition.md` — sizing and the competitive gap, with sources
- `plan/03-offer-and-pricing.md` — the four rungs and why they are priced as they are
- `plan/04-go-to-market.md` — the first 90 days through the accountant channel
- `plan/05-operations-and-legal.md` — formation, the brokerage licensing boundary, delivery
- `plan/06-brand.md` — name, voice, visual identity
- `model/` — runnable 24-month operating model
- `product/appraise/` — the working appraisal engine
- `templates/engagement-letter.md` — fixed-price engagement letter
- `site/index.html` — landing page

## Run it

```bash
# What a business would fetch, and what each gap to sellability is worth
node business/understudy/product/appraise/src/cli.mjs \
  business/understudy/product/appraise/fixtures/ridgeline-hvac.json

# The business's own 24-month operating model
node business/understudy/model/run.mjs

# Tests
node --test 'business/understudy/product/appraise/test/*.test.mjs'
node --test 'business/understudy/model/test/*.test.mjs'
```

Dependency-free, Node 22+.
