/**
 * Lane geography without a maps provider.
 *
 * There is no geocoding or routing integration yet, so distance comes from
 * region centroids and a great-circle formula. That is honest enough to rank
 * suppliers and to frame a rate band, and it is deliberately wrong for
 * door-to-door mileage: the UI labels it an estimate, and a routing adapter
 * (see README, "Requires external integration") replaces this module's
 * `laneMiles` without touching the matching code.
 */

import type { Place } from "./types.ts";

export type RegionKey = string; // "US-FL", "US-PR", "DO-SD"

type Centroid = { lat: number; lon: number; name: string };

/** Focused on the Caribbean/US corridor the marketplace launches on, plus the mainland states it feeds. */
const REGION_CENTROIDS: Record<RegionKey, Centroid> = {
  "US-PR": { lat: 18.22, lon: -66.43, name: "Puerto Rico" },
  "US-FL": { lat: 27.77, lon: -81.69, name: "Florida" },
  "US-GA": { lat: 32.66, lon: -83.44, name: "Georgia" },
  "US-AL": { lat: 32.8, lon: -86.79, name: "Alabama" },
  "US-SC": { lat: 33.86, lon: -80.95, name: "South Carolina" },
  "US-NC": { lat: 35.63, lon: -79.81, name: "North Carolina" },
  "US-TN": { lat: 35.75, lon: -86.69, name: "Tennessee" },
  "US-VA": { lat: 37.52, lon: -78.85, name: "Virginia" },
  "US-MD": { lat: 39.06, lon: -76.8, name: "Maryland" },
  "US-PA": { lat: 40.59, lon: -77.21, name: "Pennsylvania" },
  "US-NJ": { lat: 40.3, lon: -74.52, name: "New Jersey" },
  "US-NY": { lat: 42.17, lon: -74.95, name: "New York" },
  "US-TX": { lat: 31.05, lon: -97.56, name: "Texas" },
  "US-LA": { lat: 31.17, lon: -91.87, name: "Louisiana" },
  "US-IL": { lat: 40.35, lon: -88.99, name: "Illinois" },
  "US-OH": { lat: 40.39, lon: -82.76, name: "Ohio" },
  "US-CA": { lat: 36.12, lon: -119.68, name: "California" },
  "US-VI": { lat: 18.34, lon: -64.9, name: "US Virgin Islands" },
  "DO-SD": { lat: 18.48, lon: -69.93, name: "Santo Domingo" },
  "DO-ST": { lat: 19.45, lon: -70.7, name: "Santiago" },
};

/** Regions that share a land border, used to score near-miss coverage. */
const NEIGHBORS: Record<RegionKey, readonly RegionKey[]> = {
  "US-FL": ["US-GA", "US-AL"],
  "US-GA": ["US-FL", "US-AL", "US-SC", "US-NC", "US-TN"],
  "US-AL": ["US-FL", "US-GA", "US-TN"],
  "US-SC": ["US-GA", "US-NC"],
  "US-NC": ["US-SC", "US-GA", "US-TN", "US-VA"],
  "US-TN": ["US-GA", "US-AL", "US-NC", "US-VA"],
  "US-VA": ["US-NC", "US-TN", "US-MD"],
  "US-MD": ["US-VA", "US-PA"],
  "US-PA": ["US-MD", "US-NJ", "US-NY", "US-OH"],
  "US-NJ": ["US-PA", "US-NY"],
  "US-NY": ["US-NJ", "US-PA"],
  "US-OH": ["US-PA"],
  "US-TX": ["US-LA"],
  "US-LA": ["US-TX"],
  "US-PR": ["US-VI"],
  "US-VI": ["US-PR"],
  "DO-SD": ["DO-ST"],
  "DO-ST": ["DO-SD"],
};

export function regionKey(place: Place): RegionKey {
  return `${place.country.toUpperCase()}-${place.region.toUpperCase()}`;
}

export function regionName(key: RegionKey): string {
  return REGION_CENTROIDS[key]?.name ?? key;
}

export function knownRegions(): RegionKey[] {
  return Object.keys(REGION_CENTROIDS).sort();
}

export function isKnownRegion(key: RegionKey): boolean {
  return key in REGION_CENTROIDS;
}

export function areNeighbors(a: RegionKey, b: RegionKey): boolean {
  return NEIGHBORS[a]?.includes(b) ?? false;
}

/** True when the lane cannot be driven end to end, so it needs ocean or air. */
export function crossesWater(origin: RegionKey, destination: RegionKey): boolean {
  const island = (key: RegionKey) => key.startsWith("DO-") || key === "US-PR" || key === "US-VI";
  if (island(origin) === island(destination)) {
    // Two islands still need a boat unless they are the same island group.
    if (!island(origin)) return false;
    const group = (key: RegionKey) => (key.startsWith("DO-") ? "DO" : key);
    return group(origin) !== group(destination);
  }
  return true;
}

function haversineMiles(a: Centroid, b: Centroid): number {
  const R = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Straight-line distance between region centroids, inflated by a road-circuity
 * factor for drivable lanes. Returns null for regions we have no centroid for,
 * and callers must treat null as "unknown", never as zero.
 */
export function laneMiles(origin: RegionKey, destination: RegionKey): number | null {
  const a = REGION_CENTROIDS[origin];
  const b = REGION_CENTROIDS[destination];
  if (!a || !b) return null;
  const straight = haversineMiles(a, b);
  if (crossesWater(origin, destination)) return Math.round(straight);
  // Roads are not straight lines; 1.18 is the usual circuity rule of thumb.
  return Math.round(straight * 1.18);
}
