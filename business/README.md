# Plimsoll

**The load line for agent-written code.**

A ship's Plimsoll line marks how heavily it can safely be loaded. Engineering teams now
carry a large and growing share of machine-written code with no equivalent mark — no idea
what fraction of merged code an agent wrote, and no idea whether that code fails more than
the code their people write.

This directory is a complete, self-contained business built around answering that question.

## Status

| Piece | State |
| --- | --- |
| Product wedge (`plimsoll` CLI) | **Working.** 18 passing tests, runs on any git repo |
| Operating model | **Working.** 11 passing tests, 24-month projection |
| Positioning, pricing, GTM | Written, grounded in cited 2026 market data |
| Legal entity, bank, contracts | **Blocked — requires a human signature.** See `plan/05-operations-and-legal.md` |

## Contents

- `decisions/00-decision-memo.md` — what business, why this one, what was rejected
- `plan/01-business-plan.md` — the whole thing in one document
- `plan/02-market-and-competition.md` — market sizing and the competitive gap, with sources
- `plan/03-offer-and-pricing.md` — what is sold and for how much
- `plan/04-go-to-market.md` — first 90 days, concretely
- `plan/05-operations-and-legal.md` — formation checklist and what a human must do
- `plan/06-brand.md` — name, voice, visual identity
- `model/` — runnable 24-month operating model
- `product/plimsoll/` — the working product wedge
- `templates/audit-sow.md` — fixed-price engagement contract
- `site/index.html` — landing page

## Run it

```bash
# The product: analyse any repository's agent-authored code risk
node business/product/plimsoll/src/cli.mjs /path/to/repo --since "12 months ago"

# The business: 24-month operating model
node business/model/run.mjs

# Tests
node --test 'business/product/plimsoll/test/*.test.mjs'
node --test 'business/model/test/*.test.mjs'
```

Both are dependency-free and run on Node 22+.
