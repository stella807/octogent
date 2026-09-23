/**
 * Shipment-to-supplier matching.
 *
 * Two stages, kept separate on purpose:
 *
 *   1. Eligibility — hard requirements. A supplier that cannot legally or
 *      physically run the load is excluded, with the reason kept so the
 *      shipper sees who was filtered out and why.
 *   2. Scoring — weighted, transparent factors. Every factor reports its own
 *      score, weight and a sentence of evidence.
 *
 * The score never awards a shipment. It orders a list and explains itself; the
 * shipper decides. Factors with no data score neutral (0.5) and say so, so a
 * new supplier is not quietly buried under an unexplained number.
 */

import { areNeighbors, crossesWater, laneMiles, regionKey } from "./geo.ts";
import { CARGO_EQUIPMENT_REQUIREMENTS } from "./types.ts";
import type { Company, Shipment, SupplierProfile, SupplierStats } from "./types.ts";

export type MatchFactor = {
  key: string;
  label: string;
  weight: number;
  /** 0..1 */
  score: number;
  detail: string;
  /** True when the factor had nothing to measure and fell back to neutral. */
  neutral?: boolean;
};

export type MatchResult = {
  companyId: string;
  companyName: string;
  eligible: boolean;
  /** 0..100, rounded. Zero for ineligible suppliers. */
  matchPercent: number;
  factors: MatchFactor[];
  exclusions: string[];
  verificationStatus: Company["verificationStatus"];
};

export type MatchInput = {
  company: Company;
  profile: SupplierProfile;
  stats: SupplierStats;
};

const NEUTRAL = 0.5;

/** Enum values read as code; suppliers and shippers read English. */
const label = (value: string): string => value.replaceAll("_", " ");

const WEIGHTS = {
  originCoverage: 0.18,
  destinationCoverage: 0.18,
  laneExperience: 0.1,
  cargoFit: 0.1,
  availability: 0.1,
  performance: 0.12,
  responsiveness: 0.06,
  price: 0.08,
  verification: 0.08,
} as const;

function coverageScore(
  profile: SupplierProfile,
  region: string,
): { score: number; detail: string } {
  if (profile.serviceRegions.includes(region)) {
    return { score: 1, detail: `Serves ${region} directly` };
  }
  const neighbor = profile.serviceRegions.find((served) => areNeighbors(served, region));
  if (neighbor) {
    return { score: 0.45, detail: `Does not list ${region}; serves neighboring ${neighbor}` };
  }
  return { score: 0, detail: `Does not serve ${region}` };
}

function laneExperienceScore(
  profile: SupplierProfile,
  origin: string,
  destination: string,
): { score: number; detail: string } {
  if (profile.lanes.some((lane) => lane.origin === origin && lane.destination === destination)) {
    return { score: 1, detail: `Runs ${origin} → ${destination} as a declared lane` };
  }
  if (profile.lanes.some((lane) => lane.origin === destination && lane.destination === origin)) {
    return { score: 0.8, detail: `Runs the reverse lane ${destination} → ${origin}` };
  }
  if (profile.lanes.some((lane) => lane.origin === origin || lane.destination === destination)) {
    return { score: 0.5, detail: "Runs lanes sharing one end of this route" };
  }
  return { score: 0.25, detail: "No declared lane overlaps this route" };
}

function cargoFitScore(
  profile: SupplierProfile,
  shipment: Shipment,
): { score: number; detail: string } {
  const handlesCargo = profile.cargoTypes.includes(shipment.cargoType);
  const weightHeadroom =
    profile.maxWeightLbs > 0 ? 1 - shipment.weightLbs / profile.maxWeightLbs : 0;
  const weightScore = Math.max(0, Math.min(1, weightHeadroom * 2)); // full marks at 50% of capacity
  const score = (handlesCargo ? 1 : 0.4) * 0.6 + weightScore * 0.4;
  const detail = handlesCargo
    ? `Handles ${label(shipment.cargoType)}; load is ${Math.round((shipment.weightLbs / Math.max(1, profile.maxWeightLbs)) * 100)}% of stated capacity`
    : `Does not list ${label(shipment.cargoType)} among handled cargo`;
  return { score, detail };
}

function availabilityScore(
  profile: SupplierProfile,
  shipment: Shipment,
): { score: number; detail: string } {
  const pickupDays = datesInWindow(shipment.pickupFrom, shipment.pickupTo);
  if (pickupDays.length === 0) return { score: NEUTRAL, detail: "Pickup window could not be read" };
  const open = pickupDays.filter((day) => !profile.blackoutDates.includes(day));
  if (open.length === 0) {
    return { score: 0, detail: "Blacked out for every day of the pickup window" };
  }
  const ratio = open.length / pickupDays.length;
  return {
    score: ratio,
    detail:
      ratio === 1
        ? `Available on all ${pickupDays.length} day(s) of the pickup window`
        : `Available ${open.length} of ${pickupDays.length} day(s) in the pickup window`,
  };
}

function performanceScore(stats: SupplierStats): {
  score: number;
  detail: string;
  neutral: boolean;
} {
  const delivered = stats.onTimeDeliveries + stats.lateDeliveries;
  if (delivered === 0) {
    return {
      score: NEUTRAL,
      detail: "No completed shipments on the platform yet — scored neutral, not penalised",
      neutral: true,
    };
  }
  const onTime = stats.onTimeDeliveries / delivered;
  const cancelRate =
    stats.cancellations / Math.max(1, stats.completedShipments + stats.cancellations);
  // Confidence grows with sample size; 10 deliveries reaches full weight.
  const confidence = Math.min(1, delivered / 10);
  const raw = Math.max(0, onTime - cancelRate);
  const score = NEUTRAL + (raw - NEUTRAL) * confidence;
  return {
    score: Math.max(0, Math.min(1, score)),
    detail: `${Math.round(onTime * 100)}% on time over ${delivered} delivery(ies), ${stats.cancellations} cancellation(s)`,
    neutral: false,
  };
}

function responsivenessScore(stats: SupplierStats): {
  score: number;
  detail: string;
  neutral: boolean;
} {
  if (stats.opportunitiesSeen === 0) {
    return { score: NEUTRAL, detail: "No opportunities seen yet", neutral: true };
  }
  const responseRate = Math.min(1, stats.quotesSubmitted / stats.opportunitiesSeen);
  if (stats.responsesCounted === 0) {
    return {
      score: responseRate,
      detail: `Quotes on ${Math.round(responseRate * 100)}% of opportunities seen`,
      neutral: false,
    };
  }
  const medianHours = stats.responseSecondsTotal / stats.responsesCounted / 3600;
  // Under 2h is fast, over 24h adds nothing.
  const speed = Math.max(0, Math.min(1, (24 - medianHours) / 22));
  return {
    score: responseRate * 0.6 + speed * 0.4,
    detail: `Quotes on ${Math.round(responseRate * 100)}% of opportunities, average reply ${medianHours.toFixed(1)}h`,
    neutral: false,
  };
}

function priceScore(
  profile: SupplierProfile,
  shipment: Shipment,
  miles: number | null,
): { score: number; detail: string; neutral: boolean } {
  if (profile.ratePerMileCents === null || miles === null) {
    return {
      score: NEUTRAL,
      detail: "No published rate to compare — the supplier's quote is the real number",
      neutral: true,
    };
  }
  const indicative = profile.ratePerMileCents * miles;
  if (shipment.targetPriceCents === null) {
    return {
      score: NEUTRAL,
      detail: `Indicative ${formatUsd(indicative)} at their published rate; no shipper target to compare`,
      neutral: true,
    };
  }
  const ratio = indicative / shipment.targetPriceCents;
  // At or under target scores full; 40% over target scores zero.
  const score = Math.max(0, Math.min(1, (1.4 - ratio) / 0.4));
  return {
    score,
    detail: `Indicative ${formatUsd(indicative)} vs target ${formatUsd(shipment.targetPriceCents)} (${Math.round((ratio - 1) * 100)}%)`,
    neutral: false,
  };
}

function verificationScore(company: Company): { score: number; detail: string } {
  switch (company.verificationStatus) {
    case "verified":
      return { score: 1, detail: "Verified by platform admin" };
    case "pending":
      return { score: 0.4, detail: "Verification submitted, awaiting review" };
    case "rejected":
      return { score: 0, detail: "Verification rejected" };
    default:
      return { score: 0.2, detail: "Not verified" };
  }
}

/** Hard requirements. Returns the reasons a supplier cannot run this load. */
export function eligibilityFailures(shipment: Shipment, input: MatchInput): string[] {
  const { company, profile } = input;
  const reasons: string[] = [];
  const origin = regionKey(shipment.origin);
  const destination = regionKey(shipment.destination);

  if (!profile.equipment.includes(shipment.equipment)) {
    reasons.push(`No ${label(shipment.equipment)} in fleet`);
  }
  const cargoRequires = CARGO_EQUIPMENT_REQUIREMENTS[shipment.cargoType];
  if (cargoRequires && !profile.equipment.some((item) => cargoRequires.includes(item))) {
    reasons.push(
      `${label(shipment.cargoType)} needs one of: ${cargoRequires.map(label).join(", ")}`,
    );
  }
  if (profile.maxWeightLbs > 0 && shipment.weightLbs > profile.maxWeightLbs) {
    reasons.push(
      `Load is ${shipment.weightLbs.toLocaleString()} lb, over the ${profile.maxWeightLbs.toLocaleString()} lb stated maximum`,
    );
  }
  const missingCapabilities = shipment.specialRequirements.filter(
    (requirement) => !profile.capabilities.includes(requirement),
  );
  if (missingCapabilities.length > 0) {
    reasons.push(`Missing required capability: ${missingCapabilities.map(label).join(", ")}`);
  }
  // Serving neither end of the lane is disqualifying; one end is merely weak.
  const servesEither =
    profile.serviceRegions.includes(origin) ||
    profile.serviceRegions.includes(destination) ||
    profile.serviceRegions.some(
      (served) => areNeighbors(served, origin) || areNeighbors(served, destination),
    );
  if (!servesEither) {
    reasons.push(`Serves neither ${origin} nor ${destination}`);
  }
  if (company.verificationStatus === "rejected") {
    reasons.push("Verification rejected by platform admin");
  }
  return reasons;
}

export function scoreSupplier(shipment: Shipment, input: MatchInput): MatchResult {
  const { company, profile, stats } = input;
  const origin = regionKey(shipment.origin);
  const destination = regionKey(shipment.destination);
  const exclusions = eligibilityFailures(shipment, input);

  const originCoverage = coverageScore(profile, origin);
  const destinationCoverage = coverageScore(profile, destination);
  const lane = laneExperienceScore(profile, origin, destination);
  const cargo = cargoFitScore(profile, shipment);
  const availability = availabilityScore(profile, shipment);
  const performance = performanceScore(stats);
  const responsiveness = responsivenessScore(stats);
  const price = priceScore(profile, shipment, laneMiles(origin, destination));
  const verification = verificationScore(company);

  const factors: MatchFactor[] = [
    {
      key: "originCoverage",
      label: "Origin coverage",
      weight: WEIGHTS.originCoverage,
      ...originCoverage,
    },
    {
      key: "destinationCoverage",
      label: "Destination coverage",
      weight: WEIGHTS.destinationCoverage,
      ...destinationCoverage,
    },
    { key: "laneExperience", label: "Lane experience", weight: WEIGHTS.laneExperience, ...lane },
    { key: "cargoFit", label: "Cargo and capacity fit", weight: WEIGHTS.cargoFit, ...cargo },
    {
      key: "availability",
      label: "Pickup availability",
      weight: WEIGHTS.availability,
      ...availability,
    },
    {
      key: "performance",
      label: "Delivery performance",
      weight: WEIGHTS.performance,
      ...performance,
    },
    {
      key: "responsiveness",
      label: "Responsiveness",
      weight: WEIGHTS.responsiveness,
      ...responsiveness,
    },
    { key: "price", label: "Price competitiveness", weight: WEIGHTS.price, ...price },
    { key: "verification", label: "Verification", weight: WEIGHTS.verification, ...verification },
  ];

  const weighted = factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0);
  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);

  return {
    companyId: company.id,
    companyName: company.name,
    eligible: exclusions.length === 0,
    matchPercent: exclusions.length === 0 ? Math.round((weighted / totalWeight) * 100) : 0,
    factors,
    exclusions,
    verificationStatus: company.verificationStatus,
  };
}

/** Ranked eligible suppliers first, then the excluded ones with their reasons. */
export function rankSuppliers(shipment: Shipment, inputs: MatchInput[]): MatchResult[] {
  const results = inputs.map((input) => scoreSupplier(shipment, input));
  const eligible = results
    .filter((result) => result.eligible)
    .sort((a, b) => b.matchPercent - a.matchPercent || a.companyName.localeCompare(b.companyName));
  const excluded = results
    .filter((result) => !result.eligible)
    .sort((a, b) => a.companyName.localeCompare(b.companyName));
  return [...eligible, ...excluded];
}

/**
 * How well a posted shipment suits a given supplier, used to order the
 * supplier's opportunity feed. Same scoring, read from the other side.
 */
export function rankOpportunities(
  shipments: Shipment[],
  input: MatchInput,
): { shipment: Shipment; match: MatchResult }[] {
  return shipments
    .map((shipment) => ({ shipment, match: scoreSupplier(shipment, input) }))
    .filter((entry) => entry.match.eligible)
    .sort((a, b) => b.match.matchPercent - a.match.matchPercent);
}

export function datesInWindow(from: string, to: string): string[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const days: string[] = [];
  for (let time = start; time <= end && days.length < 60; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
