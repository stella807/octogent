# appraise

**What a main street business would fetch, and what each gap to sellability is worth.**

Takes a business profile, returns a likely sale range and a ranked, dollar-valued work order.
No dependencies. Node 22+.

## Use

```bash
node src/cli.mjs fixtures/ridgeline-hvac.json
node src/cli.mjs my-business.json --json
```

## Example

```
  UNDERSTUDY   Ridgeline Heating & Air
  home-services · sellability appraisal

  EARNINGS
  Net profit                               $118,000
    + Owner's salary                        $95,000
    + Owner's benefits                      $16,000
    + Discretionary spending                $21,000
    + One-time costs                        $12,000
    + Interest                               $9,000
    + Depreciation                          $31,000
  ─────────────────────────────────────────────────
  Seller's discretionary earnings          $302,000

  ! Add-backs exceed net profit. Every line will be challenged in diligence,
    and anything you cannot document will simply be struck out.

  WHAT IT WOULD FETCH TODAY
    $453,000 – $664,400
    midpoint $558,700 at 1.85× SDE (3.5× base for this size and trade, risk-adjusted down)

  WHAT EACH GAP IS WORTH             value  months  effort   per month
  Owner dependence                $135,900      12     ●●●     $11,325
  Documented operations            $54,360       6     ●○○      $9,060
  Provable financials              $45,300       6     ●●○      $7,550
  ...

  IF YOU CLOSED ALL OF THEM
    $558,700  →  $1,307,660    (+$748,960, 4.33× SDE)
```

## How it works

**SDE first.** Every sub-$5M sale is priced on seller's discretionary earnings. Each add-back
is itemised rather than summed silently, because in diligence each one is argued individually
and anything undocumented is struck out. When add-backs exceed net profit, the report says so
— that is when buyers stop believing the earnings.

**Base multiple** from earnings size and trade, calibrated to 2026 closed-transaction
reporting: a 2.6–2.7× market average, 2.5–3.5× at $250–500k of SDE, 3–4× for home services,
and a floor around 1.4× for distressed retail.

**Risk adjustment** across the seven things buyers and SBA lenders actually interrogate:
owner dependence, provable financials, customer concentration, recurring revenue, documented
operations, team continuity, transferable rights.

**Gap pricing.** Each open gap is valued by moving that one factor to its target while
holding everything else where it is — which is how the owner experiences the decision — then
ranked by value earned per month of effort.

### Three deliberate modelling choices

1. **Risk saturates; it does not sum.** The first version added discounts linearly, which
   pinned any realistically troubled business to the multiple floor and made every individual
   improvement appear worth exactly nothing. Risks overlap in reality — the owner-dependent
   business is usually the undocumented one — so the total discount saturates. It stays
   bounded and monotonic, so improving anything always helps, with diminishing returns.

2. **Some businesses get no price at all.** Commingled cash books are not a discount, they
   are a gate: more than half of deals collapse in diligence and roughly 45% die on financial
   issues. A business no lender will finance has no honest asking price, and printing one
   would be the most harmful thing this tool could do. It returns **not listable** instead.

3. **Targets must be reachable.** Every factor's target state is one the scorer can actually
   produce. A work order made of impossible steps is not a work order — and an unreachable
   target shows up as a permanent phantom gap the owner can never close.

## Limits

- **This is not a certified valuation** and is not USPAP-compliant. It is an estimate of a
  likely sale range and reports a range, never a point.
- It is only as good as the figures given to it. It does not audit anything.
- Multiples vary by geography, timing and buyer type in ways no general model captures. Check
  against recent comparable sales in the trade.
- It is calibrated to US main street transactions under roughly $5M.

## Design

```
src/sde.mjs        earnings normalisation, pure
src/factors.mjs    base multiples, risk factors, saturating aggregation, pure
src/appraise.mjs   combines the above and prices the gaps, pure
src/render.mjs     terminal presentation, no valuation logic
src/cli.mjs        argument parsing and wiring
```

## Test

```bash
node --test 'test/*.test.mjs'
```

43 tests, no fixtures required — the engine is pure.
