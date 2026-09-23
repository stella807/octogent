/**
 * Rate guidance shown to suppliers on the opportunity board.
 *
 * Preference order: what this marketplace actually paid on comparable lanes,
 * then a per-mile heuristic. The result always states which one it used, since
 * a made-up band presented as market data is the fastest way to lose a carrier.
 */

import { laneMiles, regionKey } from "./geo.ts";
import type { EquipmentType, Shipment } from "./types.ts";

export type RateBand = {
  lowCents: number;
  highCents: number;
  basis: "platform_history" | "distance_heuristic";
  detail: string;
  miles: number | null;
};

/** All-in cents per mile, before the water crossing surcharge below. */
const HEURISTIC_RATE_PER_MILE: Record<EquipmentType, number> = {
  dry_van: 210,
  reefer: 275,
  flatbed: 250,
  step_deck: 285,
  container_20: 195,
  container_40: 215,
  box_truck: 240,
  tanker: 300,
};

/**
 * Ocean lanes are priced per container by the carrier, not per mile, so a
 * per-mile figure is meaningless on them. These are deliberately coarse
 * placeholders until a real rate API is connected (see README); the band they
 * produce is labelled as an estimate everywhere it is shown.
 */
const OCEAN_BASE_CENTS: Record<EquipmentType, number> = {
  dry_van: 360_000,
  reefer: 520_000,
  flatbed: 420_000,
  step_deck: 460_000,
  container_20: 300_000,
  container_40: 390_000,
  box_truck: 340_000,
  tanker: 560_000,
};

export type ComparableAward = {
  originRegion: string;
  destinationRegion: string;
  equipment: EquipmentType;
  priceCents: number;
};

export function suggestRate(shipment: Shipment, comparables: ComparableAward[]): RateBand {
  const origin = regionKey(shipment.origin);
  const destination = regionKey(shipment.destination);
  const miles = laneMiles(origin, destination);

  const onLane = comparables.filter(
    (award) =>
      award.equipment === shipment.equipment &&
      ((award.originRegion === origin && award.destinationRegion === destination) ||
        (award.originRegion === destination && award.destinationRegion === origin)),
  );

  if (onLane.length >= 3) {
    const prices = onLane.map((award) => award.priceCents).sort((a, b) => a - b);
    return {
      lowCents: percentile(prices, 0.25),
      highCents: percentile(prices, 0.75),
      basis: "platform_history",
      detail: `Middle half of ${onLane.length} awarded ${shipment.equipment} shipments on this lane`,
      miles,
    };
  }

  if (miles === null) {
    const fallback = 250_000;
    return {
      lowCents: Math.round(fallback * 0.85),
      highCents: Math.round(fallback * 1.15),
      basis: "distance_heuristic",
      detail: "Unknown lane distance — wide placeholder band, quote from your own cost model",
      miles,
    };
  }

  const overWater = needsWaterLeg(origin, destination);
  const perMile = HEURISTIC_RATE_PER_MILE[shipment.equipment];
  const base = overWater ? OCEAN_BASE_CENTS[shipment.equipment] : perMile * miles;
  const weightFactor = shipment.weightLbs > 30_000 ? 1.1 : 1;
  const midpoint = base * weightFactor;
  return {
    lowCents: Math.round(midpoint * 0.85),
    highCents: Math.round(midpoint * 1.15),
    basis: "distance_heuristic",
    detail: overWater
      ? `Ocean lane: flat ${shipment.equipment.replaceAll("_", " ")} placeholder, since carriers price the container, not the mile`
      : `${(perMile / 100).toFixed(2)}/mi × ${miles.toLocaleString()} estimated mi`,
    miles,
  };
}

function needsWaterLeg(origin: string, destination: string): boolean {
  const island = (key: string) => key.startsWith("DO-") || key === "US-PR" || key === "US-VI";
  return island(origin) !== island(destination) || (island(origin) && origin !== destination);
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index] as number;
}
