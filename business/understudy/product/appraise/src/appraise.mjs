import {
  MULTIPLE_CEILING,
  MULTIPLE_FLOOR,
  aggregateDelta,
  assessFactors,
  baseMultiple,
  clamp,
  round2,
} from "./factors.mjs";
import { normalizeSde } from "./sde.mjs";

/** Spread applied either side of the point estimate. A single number here would be a lie. */
const RANGE_SPREAD = 0.35;

const multipleFrom = (base, deltas) =>
  round2(clamp(base + aggregateDelta(deltas), MULTIPLE_FLOOR, MULTIPLE_CEILING));

/**
 * Appraise a business and price its gaps.
 *
 * @param {object} profile {name, industry, financials, risk}
 */
export function appraise(profile) {
  const earnings = normalizeSde(profile.financials);
  const base = baseMultiple(earnings.sde, profile.industry);
  const factors = assessFactors(profile.risk);

  const deltas = factors.map((factor) => factor.delta);
  const multiple = multipleFrom(base, deltas);

  const blockers = factors.filter((factor) => factor.blocking);
  const listable = blockers.length === 0 && earnings.viable;

  // A business that cannot be financed has no meaningful asking price, and printing one
  // would be the single most harmful thing this tool could do to an owner's expectations.
  const value = listable
    ? {
        mid: Math.round(earnings.sde * multiple),
        // The low end is allowed below the point-estimate floor: a distressed business
        // really does trade under 1x, and hiding that would flatter the seller.
        low: Math.round(earnings.sde * Math.max(0.5, multiple - RANGE_SPREAD)),
        high: Math.round(earnings.sde * Math.min(MULTIPLE_CEILING, multiple + RANGE_SPREAD)),
      }
    : { mid: null, low: null, high: null };

  const gaps = factors
    .filter((factor) => factor.upside > 0)
    .map((factor) => {
      // Each gap is priced holding every other factor where it is, which is how an owner
      // experiences the decision: this one change, from today.
      const fixed = factors.map((other) =>
        other.id === factor.id ? other.targetDelta : other.delta,
      );
      const liftedMultiple = multipleFrom(base, fixed);
      const lift = round2(liftedMultiple - multiple);
      const gapValue = Math.round(earnings.sde * lift);
      return {
        id: factor.id,
        label: factor.label,
        target: factor.target,
        upside: lift,
        value: gapValue,
        effortMonths: factor.effortMonths,
        difficulty: factor.difficulty,
        valuePerMonth: Math.round(gapValue / factor.effortMonths),
        blocking: factor.blocking,
      };
    })
    .sort((a, b) => b.valuePerMonth - a.valuePerMonth);

  const allFixedMultiple = multipleFrom(
    base,
    factors.map((factor) => factor.targetDelta),
  );
  const combinedValue = Math.round(earnings.sde * (allFixedMultiple - multiple));
  const naiveSum = gaps.reduce((sum, gap) => sum + gap.value, 0);

  return {
    name: profile.name,
    industry: profile.industry,
    earnings,
    sde: earnings.sde,
    base,
    multiple,
    value,
    factors,
    gaps,
    combined: {
      multiple: allFixedMultiple,
      value: combinedValue,
      naiveSum,
      divergence: combinedValue - naiveSum,
      // Gaps interact and the multiple is clamped, so adding the individual figures
      // overstates the result. Reporting both keeps the arithmetic honest.
      overstated: naiveSum > combinedValue,
      effortMonths: Math.max(...gaps.map((gap) => gap.effortMonths), 0),
    },
    verdict: {
      listable,
      blockers: blockers.map((factor) => ({ id: factor.id, label: factor.label })),
      addBackHeavy: earnings.addBackHeavy,
    },
  };
}
