/**
 * The lane map's view model.
 *
 * Shipments are grouped into lanes and given coordinates, and that is all. No
 * position is invented: the marketplace has no AIS, no ELD and no telematics
 * feed, so a load in transit has a stage, not a dot moving across the water.
 * The map draws where freight is going, not where it currently is — and every
 * endpoint says whether its coordinates are a city or a whole region.
 */

import { crossesWater, locate, placeMiles, regionKey } from "../domain/geo.ts";
import type { Located } from "../domain/geo.ts";
import type { Place, Shipment, ShipmentStatus } from "../domain/types.ts";
import type { Store } from "../ports/store.ts";
import type { Principal } from "./principal.ts";
import { resolveScope, scopedShipments } from "./scope.ts";
import type { Scope } from "./scope.ts";

/** A bound on what one response will carry; the map says so when it bites. */
const SHIPMENT_LIMIT = 500;

export type LaneEndpoint = {
  key: string;
  label: string;
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
  precision: Located["precision"];
};

export type LaneShipment = {
  id: string;
  reference: string;
  status: ShipmentStatus;
  equipment: string;
  cargoType: string;
  weightLbs: number;
  palletCount: number;
  pickupFrom: string;
  pickupTo: string;
  deliverBy: string | null;
  /** The awarded price, or null while the load is still being bid. */
  awardedCents: number | null;
  counterpartyName: string | null;
};

export type Lane = {
  id: string;
  origin: LaneEndpoint;
  destination: LaneEndpoint;
  /** True when the lane cannot be driven end to end, so it needs a vessel. */
  crossesWater: boolean;
  estimatedMiles: number | null;
  shipments: LaneShipment[];
  counts: Record<ShipmentStatus, number>;
  awardedValueCents: number;
};

export type LaneMapView = {
  scope: Scope;
  generatedAt: string;
  lanes: Lane[];
  /** Shipments the map could not place, named rather than silently dropped. */
  unplaced: { id: string; reference: string; reason: string }[];
  totals: {
    shipments: number;
    lanes: number;
    awardedValueCents: number;
    regionPrecisionEndpoints: number;
    truncated: boolean;
  };
};

export function laneMapView(store: Store, principal: Principal): LaneMapView {
  const scope = resolveScope(principal);
  const companyId = principal.company?.id ?? null;
  const all = scopedShipments(store, scope, companyId);
  const shipments = all.slice(0, SHIPMENT_LIMIT);

  const lanes = new Map<string, Lane>();
  const unplaced: LaneMapView["unplaced"] = [];

  for (const shipment of shipments) {
    const origin = endpointOf(shipment.origin);
    const destination = endpointOf(shipment.destination);
    if (!origin || !destination) {
      unplaced.push({
        id: shipment.id,
        reference: shipment.reference,
        reason: `No coordinates for ${!origin ? regionKey(shipment.origin) : regionKey(shipment.destination)}`,
      });
      continue;
    }

    const id = `${origin.key}→${destination.key}`;
    const lane =
      lanes.get(id) ??
      ({
        id,
        origin,
        destination,
        crossesWater: crossesWater(regionKey(shipment.origin), regionKey(shipment.destination)),
        estimatedMiles: placeMiles(shipment.origin, shipment.destination),
        shipments: [],
        counts: emptyCounts(),
        awardedValueCents: 0,
      } satisfies Lane);

    const awarded = shipment.awardedQuoteId ? store.getQuote(shipment.awardedQuoteId) : null;
    lane.shipments.push({
      id: shipment.id,
      reference: shipment.reference,
      status: shipment.status,
      equipment: shipment.equipment,
      cargoType: shipment.cargoType,
      weightLbs: shipment.weightLbs,
      palletCount: shipment.palletCount,
      pickupFrom: shipment.pickupFrom,
      pickupTo: shipment.pickupTo,
      deliverBy: shipment.deliverBy,
      awardedCents: awarded?.priceCents ?? null,
      counterpartyName: counterparty(store, scope, shipment, awarded?.supplierCompanyId ?? null),
    });
    lane.counts[shipment.status] += 1;
    if (awarded) lane.awardedValueCents += awarded.priceCents;
    lanes.set(id, lane);
  }

  const ordered = [...lanes.values()].sort(
    (a, b) => b.shipments.length - a.shipments.length || a.id.localeCompare(b.id),
  );
  const endpoints = new Set<string>();
  let regionPrecisionEndpoints = 0;
  for (const lane of ordered) {
    for (const endpoint of [lane.origin, lane.destination]) {
      if (endpoints.has(endpoint.key)) continue;
      endpoints.add(endpoint.key);
      if (endpoint.precision === "region") regionPrecisionEndpoints += 1;
    }
  }

  return {
    scope,
    generatedAt: new Date().toISOString(),
    lanes: ordered,
    unplaced,
    totals: {
      shipments: ordered.reduce((sum, lane) => sum + lane.shipments.length, 0),
      lanes: ordered.length,
      awardedValueCents: ordered.reduce((sum, lane) => sum + lane.awardedValueCents, 0),
      regionPrecisionEndpoints,
      truncated: all.length > shipments.length,
    },
  };
}

function endpointOf(place: Place): LaneEndpoint | null {
  const located = locate(place);
  if (!located) return null;
  return {
    // Coordinates are the identity: two spellings of one city collapse into one pin.
    key: `${regionKey(place)}@${located.lat},${located.lon}`,
    label: located.precision === "city" ? `${place.city}, ${place.region}` : located.label,
    city: place.city,
    region: place.region,
    country: place.country,
    lat: located.lat,
    lon: located.lon,
    precision: located.precision,
  };
}

/** Who the viewer is dealing with on this load, from their own side of it. */
function counterparty(
  store: Store,
  scope: Scope,
  shipment: Shipment,
  awardedSupplierId: string | null,
): string | null {
  if (scope === "supplier") return store.getCompany(shipment.shipperCompanyId)?.name ?? null;
  if (!awardedSupplierId) return null;
  return store.getCompany(awardedSupplierId)?.name ?? null;
}

function emptyCounts(): Record<ShipmentStatus, number> {
  return { posted: 0, awarded: 0, picked_up: 0, in_transit: 0, delivered: 0, cancelled: 0 };
}
