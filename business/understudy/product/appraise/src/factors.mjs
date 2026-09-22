/**
 * What buyers actually price, and what each gap is worth.
 *
 * A sale price for a business this size is SDE times a multiple, and the multiple is a risk
 * judgement. This module holds that judgement explicitly: a base multiple from earnings size
 * and industry, then a signed adjustment for each risk a buyer or an SBA lender interrogates.
 *
 * Every factor declares the state it is in, the state it should reach, and what reaching it
 * is worth — because an owner cannot act on a score, only on a work order.
 */

/** Base multiples by SDE band, anchored on 2026 closed-transaction reporting. */
const SIZE_BANDS = [
  { max: 100_000, multiple: 1.8 },
  { max: 250_000, multiple: 2.4 },
  { max: 500_000, multiple: 3.0 },
  { max: 1_000_000, multiple: 3.75 },
  { max: Number.POSITIVE_INFINITY, multiple: 4.5 },
];

/** Industry adjustments. "other" is neutral and is the honest default for anything unlisted. */
const INDUSTRY_ADJUSTMENT = {
  "car-wash": 1.5,
  veterinary: 0.6,
  "home-services": 0.5,
  manufacturing: 0.3,
  distribution: 0.2,
  "professional-services": 0.2,
  childcare: 0.1,
  ecommerce: 0,
  other: 0,
  pharmacy: -0.5,
  retail: -0.6,
  restaurant: -0.7,
};

const MULTIPLE_FLOOR = 1.0;
const MULTIPLE_CEILING = 6.0;

/**
 * Risk factors overlap in the real world — the owner-dependent business is usually also the
 * undocumented one — so a buyer does not discount twice in full for the same underlying
 * weakness. Summing raw deltas instead pins any troubled business to the floor, where every
 * individual improvement appears to be worth nothing, which is both wrong and useless as
 * advice. Saturating the total models the overlap and keeps every fix worth something.
 */
const MAX_DISCOUNT = 1.8;
const MAX_PREMIUM = 0.9;

/**
 * Combine per-factor deltas into one bounded adjustment.
 * Monotonic: improving any factor always improves the result, but with diminishing returns.
 */
export function aggregateDelta(deltas) {
  const sum = deltas.reduce((total, delta) => total + delta, 0);
  if (sum >= 0) return round2(MAX_PREMIUM * Math.tanh(sum / MAX_PREMIUM));
  return round2(-MAX_DISCOUNT * Math.tanh(-sum / MAX_DISCOUNT));
}

export function baseMultiple(sde, industry = "other") {
  const band = SIZE_BANDS.find((entry) => sde < entry.max) ?? SIZE_BANDS.at(-1);
  const adjustment = INDUSTRY_ADJUSTMENT[industry] ?? INDUSTRY_ADJUSTMENT.other;
  return Number.parseFloat((band.multiple + adjustment).toFixed(2));
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = (value) => Number.parseFloat(value.toFixed(2));

/**
 * Each factor scores a risk profile into a multiple delta. `targetDelta` is the delta the
 * same factor would produce in its achievable target state — not its theoretical best, since
 * a work order made of impossible steps is not a work order.
 */
export const FACTORS = [
  {
    id: "owner-dependence",
    label: "Owner dependence",
    target: "Owner out of daily delivery, relationships transferred, a second-in-command in place",
    effortMonths: 12,
    difficulty: "high",
    targetDelta: 0.15,
    score(risk) {
      let delta = 0;
      if (risk.ownerInDelivery !== false) delta -= 0.45;
      if (risk.ownerHoldsKeyRelationships !== false) delta -= 0.35;
      if (risk.secondInCommand !== true) delta -= 0.3;
      const hours = risk.ownerHoursPerWeek ?? 50;
      if (hours > 60) delta -= 0.3;
      else if (hours > 50) delta -= 0.2;
      else if (hours <= 30) delta += 0.15;
      return clamp(delta, -1.2, 0.3);
    },
  },
  {
    id: "provability",
    label: "Provable financials",
    target: "Two years of reviewed statements, no personal spending through the business",
    effortMonths: 6,
    difficulty: "medium",
    targetDelta: 0.3,
    score(risk) {
      switch (risk.financialsQuality) {
        case "audited":
          return 0.45;
        case "reviewed-statements":
          return 0.3;
        case "bookkeeping-clean":
          return 0;
        case "cash-and-commingled":
          return -1.5;
        default:
          return -0.35;
      }
    },
    // Not a discount but a gate: more than half of deals collapse in diligence, and books
    // that cannot be proven are the single most common reason. No multiple applies to a
    // business a lender will not finance.
    blocks: (risk) => risk.financialsQuality === "cash-and-commingled",
  },
  {
    id: "customer-concentration",
    label: "Customer concentration",
    target: "No single customer above 15% of revenue",
    effortMonths: 18,
    difficulty: "high",
    targetDelta: 0.1,
    score(risk) {
      const share = risk.topCustomerSharePct ?? 0.2;
      if (share >= 0.4) return -0.9;
      if (share >= 0.25) return -0.5;
      if (share >= 0.15) return -0.2;
      return 0.1;
    },
  },
  {
    id: "recurring-revenue",
    label: "Recurring revenue",
    target: "A quarter of revenue under contract or on a maintenance plan",
    effortMonths: 12,
    difficulty: "medium",
    targetDelta: 0.35,
    score(risk) {
      const share = risk.recurringRevenuePct ?? 0;
      if (share >= 0.5) return 0.6;
      if (share >= 0.25) return 0.35;
      if (share >= 0.1) return 0.1;
      return -0.15;
    },
  },
  {
    id: "process-documentation",
    label: "Documented operations",
    target: "The work written down well enough that a competent stranger could run it",
    effortMonths: 6,
    difficulty: "low",
    targetDelta: 0.25,
    score(risk) {
      switch (risk.documentedProcesses) {
        case "documented":
          return 0.25;
        case "partial":
          return -0.2;
        default:
          return -0.5;
      }
    },
  },
  {
    id: "team-continuity",
    label: "Team continuity",
    target: "A second-in-command who stays, and a stable crew",
    effortMonths: 12,
    difficulty: "medium",
    targetDelta: 0.15,
    score(risk) {
      let delta = 0;
      if (risk.secondInCommand !== true) delta -= 0.3;
      const tenure = risk.staffTenureYears ?? 2;
      if (tenure < 2) delta -= 0.2;
      else if (tenure >= 5) delta += 0.15;
      return clamp(delta, -0.5, 0.15);
    },
  },
  {
    id: "transferability",
    label: "Transferable rights",
    target: "Licences held by the company, an assignable lease, contracts that survive a sale",
    effortMonths: 9,
    difficulty: "medium",
    targetDelta: 0.15,
    score(risk) {
      let delta = 0;
      if (risk.ownerHeldLicenses === true) delta -= 0.35;
      if (risk.leaseTransferable === false) delta -= 0.25;
      if (risk.customerContracts === true) delta += 0.15;
      else delta -= 0.2;
      return clamp(delta, -0.8, 0.15);
    },
  },
];

/**
 * @param {object} risk the risk section of a business profile
 * @returns {Array<object>} one assessment per factor
 */
export function assessFactors(risk = {}) {
  return FACTORS.map((factor) => {
    const delta = round2(factor.score(risk));
    return {
      id: factor.id,
      label: factor.label,
      delta,
      targetDelta: factor.targetDelta,
      // Upside is never negative: a factor already past its target is banked, not a gap.
      upside: round2(Math.max(0, factor.targetDelta - delta)),
      target: factor.target,
      effortMonths: factor.effortMonths,
      difficulty: factor.difficulty,
      blocking: factor.blocks ? factor.blocks(risk) : false,
    };
  });
}

export { MAX_DISCOUNT, MAX_PREMIUM, MULTIPLE_CEILING, MULTIPLE_FLOOR, clamp, round2 };
