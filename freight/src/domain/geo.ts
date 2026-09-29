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

/**
 * A bounded gazetteer of the ports and freight cities this marketplace serves.
 *
 * This is a lookup table, not geocoding: a city that is not in it resolves to
 * its region centroid and is reported as region-precision, so the map can say
 * which pins are a city and which are a whole state. A geocoding adapter
 * replaces `locate` without touching anything that calls it.
 */
const CITY_COORDINATES: Record<string, { lat: number; lon: number }> = {
  "US-FL|miami": { lat: 25.77, lon: -80.19 },
  "US-FL|jacksonville": { lat: 30.33, lon: -81.66 },
  "US-FL|fort lauderdale": { lat: 26.12, lon: -80.14 },
  "US-FL|port everglades": { lat: 26.09, lon: -80.12 },
  "US-FL|palm beach": { lat: 26.71, lon: -80.05 },
  "US-FL|fort pierce": { lat: 27.45, lon: -80.33 },
  "US-FL|tampa": { lat: 27.95, lon: -82.46 },
  "US-FL|orlando": { lat: 28.54, lon: -81.38 },
  "US-PR|san juan": { lat: 18.47, lon: -66.11 },
  "US-PR|bayamon": { lat: 18.4, lon: -66.16 },
  "US-PR|guaynabo": { lat: 18.36, lon: -66.11 },
  "US-PR|caguas": { lat: 18.23, lon: -66.04 },
  "US-PR|ponce": { lat: 18.01, lon: -66.61 },
  "US-PR|mayaguez": { lat: 18.2, lon: -67.14 },
  "US-PR|aguadilla": { lat: 18.43, lon: -67.15 },
  "US-VI|charlotte amalie": { lat: 18.34, lon: -64.93 },
  "US-VI|christiansted": { lat: 17.75, lon: -64.7 },
  "DO-SD|santo domingo": { lat: 18.49, lon: -69.93 },
  "DO-SD|haina": { lat: 18.42, lon: -70.03 },
  "DO-SD|boca chica": { lat: 18.46, lon: -69.61 },
  "DO-ST|santiago": { lat: 19.45, lon: -70.7 },
  "DO-ST|puerto plata": { lat: 19.79, lon: -70.69 },
  "US-GA|savannah": { lat: 32.08, lon: -81.09 },
  "US-GA|brunswick": { lat: 31.15, lon: -81.49 },
  "US-GA|atlanta": { lat: 33.75, lon: -84.39 },
  "US-SC|charleston": { lat: 32.78, lon: -79.93 },
  "US-NC|wilmington": { lat: 34.23, lon: -77.94 },
  "US-NC|charlotte": { lat: 35.23, lon: -80.84 },
  "US-VA|norfolk": { lat: 36.85, lon: -76.29 },
  "US-VA|richmond": { lat: 37.54, lon: -77.44 },
  "US-MD|baltimore": { lat: 39.29, lon: -76.61 },
  "US-PA|philadelphia": { lat: 39.95, lon: -75.17 },
  "US-NJ|newark": { lat: 40.74, lon: -74.17 },
  "US-NJ|elizabeth": { lat: 40.66, lon: -74.21 },
  "US-NY|new york": { lat: 40.71, lon: -74.01 },
  "US-NY|brooklyn": { lat: 40.68, lon: -73.94 },
  "US-NY|albany": { lat: 42.65, lon: -73.76 },
  "US-AL|mobile": { lat: 30.69, lon: -88.04 },
  "US-AL|birmingham": { lat: 33.52, lon: -86.81 },
  "US-TN|memphis": { lat: 35.15, lon: -90.05 },
  "US-TN|nashville": { lat: 36.16, lon: -86.78 },
  "US-LA|new orleans": { lat: 29.95, lon: -90.07 },
  "US-LA|baton rouge": { lat: 30.45, lon: -91.19 },
  "US-TX|houston": { lat: 29.76, lon: -95.37 },
  "US-TX|dallas": { lat: 32.78, lon: -96.8 },
  "US-TX|san antonio": { lat: 29.42, lon: -98.49 },
  "US-TX|laredo": { lat: 27.51, lon: -99.51 },
  "US-IL|chicago": { lat: 41.88, lon: -87.63 },
  "US-OH|columbus": { lat: 39.96, lon: -83 },
  "US-OH|cleveland": { lat: 41.5, lon: -81.69 },
  "US-OH|cincinnati": { lat: 39.1, lon: -84.51 },
  "US-CA|los angeles": { lat: 34.05, lon: -118.24 },
  "US-CA|long beach": { lat: 33.77, lon: -118.19 },
  "US-CA|oakland": { lat: 37.8, lon: -122.27 },
  "US-CA|san diego": { lat: 32.72, lon: -117.16 },
  "US-CA|stockton": { lat: 37.96, lon: -121.29 },
};

/** Spellings people actually type for the same place. */
const CITY_ALIASES: Record<string, string> = {
  "ft lauderdale": "fort lauderdale",
  "ft pierce": "fort pierce",
  "west palm beach": "palm beach",
  nyc: "new york",
  "new york city": "new york",
  sju: "san juan",
  "st thomas": "charlotte amalie",
  "st croix": "christiansted",
};

export type Located = {
  lat: number;
  lon: number;
  /** "city" when the gazetteer knew the city; "region" when this is a whole subdivision. */
  precision: "city" | "region";
  label: string;
};

function normalizeCity(city: string): string {
  const cleaned = city
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return CITY_ALIASES[cleaned] ?? cleaned;
}

/** Coordinates for a place, and an honest statement of how precise they are. */
export function locate(place: Place): Located | null {
  const key = regionKey(place);
  const city = CITY_COORDINATES[`${key}|${normalizeCity(place.city)}`];
  if (city) return { ...city, precision: "city", label: `${place.city}, ${place.region}` };
  const centroid = REGION_CENTROIDS[key];
  if (!centroid) return null;
  return { lat: centroid.lat, lon: centroid.lon, precision: "region", label: centroid.name };
}

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
 * Distance between two places, at the best precision the gazetteer can give.
 *
 * City coordinates when it knows the city, region centroids when it does not,
 * inflated by a road-circuity factor on drivable lanes. This is the one mileage
 * estimate in the product: the rate band, the match score and the map all read
 * it, so they cannot disagree about how far a load is travelling. Null means
 * unknown and must never be treated as zero.
 */
export function placeMiles(origin: Place, destination: Place): number | null {
  const from = locate(origin);
  const to = locate(destination);
  if (!from || !to) return null;
  const straight = haversineMiles(
    { lat: from.lat, lon: from.lon, name: "" },
    { lat: to.lat, lon: to.lon, name: "" },
  );
  if (crossesWater(regionKey(origin), regionKey(destination))) return Math.round(straight);
  return Math.round(straight * 1.18);
}

/**
 * Straight-line distance between region centroids, inflated by a road-circuity
 * factor for drivable lanes. Prefer `placeMiles` where the caller has the full
 * places; this one exists for callers that only hold region keys.
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
