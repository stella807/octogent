# Freight Marketplace

A B2B marketplace that connects companies with freight to move to the carriers
who can move it: post a shipment, see ranked suppliers **with the reasoning
shown**, take quotes, negotiate, award, and track the load to delivery.

It runs on Node 22 with no dependencies to install — a real SQLite database
(`node:sqlite`), real password hashing and sessions, a JSON API, and a
browser client that talks to it.

```bash
cd freight
npm test                                        # 65 tests, no install needed
FREIGHT_ADMIN_PASSWORD=change-this-password \
  node --experimental-strip-types --experimental-sqlite src/seed.ts --demo
npm start                                       # http://localhost:8080
```

The demo seed creates an admin, a shipper, three suppliers with different
capabilities and histories, one open load and one delivered load (so the rate
engine has a real comparable). Every seeded account uses the password
`demo-password-1234`.

## What it does

**Shippers** post a shipment — lane, pickup window, cargo, weight, equipment,
special requirements, target price — to the whole marketplace or to a chosen
list of suppliers. They see ranked suppliers with the factors behind each
score, collect quotes, counter them, message each supplier privately, award the
load, and watch it move.

**Suppliers** publish what they can actually do — equipment, cargo classes,
regions, lanes, capabilities, weight limit, blackout dates — and get an
opportunity board filtered to loads they are *eligible* for, ranked by fit,
with a rate band and the current quote count. They quote, counter back, accept,
withdraw, and update the load's status through to delivery.

**Admins** review companies and record a verification decision with a note the
company can read, and see platform totals.

## The matching engine

Matching is the centre of the product, and it is built to be argued with.

1. **Eligibility** is a hard filter. Wrong trailer, cargo the fleet cannot
   legally carry, load over the stated weight limit, a missing capability the
   shipment requires, no coverage at either end of the lane, or a rejected
   verification — the supplier is excluded and the shipper is told which of
   those it was. Excluded suppliers stay on screen with their reasons rather
   than vanishing.
2. **Scoring** ranks whoever is left, from nine weighted factors:

   | Factor | Weight | Reads |
   | --- | --- | --- |
   | Origin coverage | 18% | Region served directly, a neighbouring region, or not at all |
   | Destination coverage | 18% | Same, at the other end |
   | Lane experience | 10% | Declared lanes, in either direction |
   | Cargo and capacity fit | 10% | Cargo class handled, load vs. stated capacity |
   | Pickup availability | 10% | Blackout dates against the pickup window |
   | Delivery performance | 12% | On-time rate and cancellations, confidence-weighted by sample size |
   | Responsiveness | 6% | Share of opportunities quoted, average time to reply |
   | Price competitiveness | 8% | Published rate against the shipper's target |
   | Verification | 8% | Admin decision on the company |

Three rules keep the number honest:

- **The score never awards anything.** It orders a list and explains itself.
  Only a person accepts an offer.
- **No data scores neutral, and says so.** A supplier with no completed
  shipments gets 0.5 on performance labelled "no completed shipments yet —
  scored neutral, not penalised", not a silent zero that buries new carriers.
- **Every factor carries its evidence.** "Available 1 of 2 day(s) in the pickup
  window" is shown next to the bar, so a shipper can disagree with the ranking
  for a specific reason.

Performance and responsiveness come only from activity on the platform —
deliveries recorded against the deadline, quotes against opportunities seen.
Nothing is imported or invented.

## Negotiation

A quote is a thread of offers that alternates sides. Whoever is *not* the last
to move may counter, accept or walk away; accepting the offer on the table
awards the shipment, whether it is the shipper accepting a price or the
supplier accepting a counter. Awarding one quote declines the rest in the same
transaction, and the losing suppliers lose access to the shipment.

## Architecture

```
src/domain/     Pure rules: matching, rate guidance, state machines, validation, geography
src/app/        Use cases and authorization, over the store port
src/ports/      The persistence interface the app layer talks to
src/adapters/   SQLite implementation of that port, plus the SQL schema
src/http/       Router, cookies/CSRF, static files — transport only
src/security/   scrypt password hashing, session and CSRF tokens
web/            Browser client: no build step, no framework, no CDN
test/           Domain tests plus end-to-end tests over real HTTP
```

Authorization lives in `src/app`, not in routes, so it holds no matter which
route reaches it. The UI enforces nothing on its own: every rule it appears to
apply is applied again on the server, and the tests prove it from the outside.

**Security.** Passwords are scrypt with per-password salts and the cost
parameters stored alongside the hash. Session cookies are random 32-byte
tokens, stored only as SHA-256, `HttpOnly` and `SameSite=Strict`; CSRF is
double-submit with a companion readable cookie echoed in a header. Sign-in is
throttled per email and verifies against a dummy hash for unknown accounts so
timing does not leak which emails exist. Every response carries a
`default-src 'self'` CSP, and the client builds DOM nodes rather than HTML
strings, so a company name or a message body can never become markup.

**Storage.** `node:sqlite` with foreign keys on and real transactions around
awarding and offer-writing. `Store` in `src/ports/store.ts` is the seam: a
Postgres adapter is a new file, not a rewrite.

## Implemented vs. requires an external integration

Everything below the line is *not* built, and nothing in the product pretends
otherwise on screen.

**Implemented and working:** accounts and companies, roles (shipper, supplier,
admin), sessions, supplier capability profiles, shipment posting with
marketplace or invite-only visibility, eligibility and scored matching with
factor-level explanations, opportunity board with filters, quoting,
counter-offers with turn-taking and expiry, award, status tracking with an
audit trail, per-shipment private messaging, verification workflow, platform
statistics, rate guidance from platform history where it exists.

**Requires an external integration (stubbed honestly, not faked):**

| Area | What exists now | What it needs |
| --- | --- | --- |
| Distance and routing | Region-centroid great-circle miles, inflated for road circuity, labelled an estimate everywhere | A routing/geocoding provider for door-to-door mileage |
| Rate guidance | Platform awards on the lane when there are ≥3; otherwise a coarse per-mile or flat ocean-lane placeholder, labelled "not market data" | A market rate API |
| Identity and authority | MC/DOT numbers recorded as entered, reviewed by an admin | FMCSA (or local equivalent) lookup |
| Insurance | An expiry date field and an admin note | Certificate ingestion and monitoring |
| Payments | Nothing. No money moves | Escrow or a payment processor, plus the fee model |
| Documents | Nothing. No BOL/POD upload | Object storage with signed URLs and retention rules |
| Notifications | Nothing. State changes are visible in-app only | Email/SMS/push provider |
| Live tracking | Status is what the supplier reports | Telematics or an ELD integration |

**Before taking money through this, talk to a lawyer.** Whether a platform
connecting shippers and carriers is acting as a broker — and what authority,
bonding and licensing that requires — depends on the jurisdictions the freight
moves through and on how the platform positions itself. That is a legal
question, not a code question, and it is the first thing to settle before
Phase 5 in the plan below.

## Commands

| Command | Does |
| --- | --- |
| `npm test` | Domain and end-to-end tests (`node --test`, no install) |
| `npm start` | Serves the API and the UI on `PORT` (default 8080) |
| `npm run dev` | Same, restarting on change |
| `npm run seed` | Creates the admin; add `-- --demo` for demo companies and loads |
| `npm run typecheck` | `tsc --noEmit` (the only step that needs an install) |

Configuration: `PORT`, `FREIGHT_DB` (default `data/freight.db`),
`FREIGHT_SECURE_COOKIES=1` when serving over HTTPS, `FREIGHT_ADMIN_EMAIL` and
`FREIGHT_ADMIN_PASSWORD` for seeding.

## Where this goes next

Phase 1 (accounts, posting, matching, bidding, chat, admin) and the transparent
matching engine of Phase 2 are here. The natural next steps, in order:

1. **Trust.** Insurance certificate upload with expiry monitoring, FMCSA
   lookup, ratings tied to completed shipments, a dispute record.
2. **Documents.** BOL and POD against the shipment, with retention rules.
3. **Notifications.** A supplier should not have to refresh a board to learn a
   counter arrived.
4. **Money.** Escrow and the fee model — after the legal question above is
   settled, not before.
