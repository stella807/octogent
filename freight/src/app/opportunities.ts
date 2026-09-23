/**
 * The supplier's opportunity board: posted shipments they are eligible for,
 * ranked by the same matching engine the shipper sees, with the filters a
 * dispatcher actually uses.
 */

import { laneMiles, regionKey } from "../domain/geo.ts";
import { rankOpportunities } from "../domain/matching.ts";
import type { MatchResult } from "../domain/matching.ts";
import { suggestRate } from "../domain/rates.ts";
import type { RateBand } from "../domain/rates.ts";
import { CARGO_TYPES, EQUIPMENT_TYPES } from "../domain/types.ts";
import type { Quote, Shipment } from "../domain/types.ts";
import { Validator } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import { badRequest } from "./errors.ts";
import { requireCompany } from "./principal.ts";
import type { Principal } from "./principal.ts";
import { canSupplierSee } from "./shipments.ts";

export type OpportunityFilters = {
  originRegion: string;
  destinationRegion: string;
  pickupFrom: string;
  pickupTo: string;
  equipment: string;
  cargoType: string;
  minPriceCents: number | null;
  maxMiles: number | null;
};

export type Opportunity = {
  shipment: Shipment;
  match: MatchResult;
  rateBand: RateBand;
  estimatedMiles: number | null;
  quoteCount: number;
  /** This supplier's own quote, when they have already bid. */
  myQuote: Pick<Quote, "id" | "status" | "priceCents" | "transitDays"> | null;
};

export function parseFilters(query: URLSearchParams): OpportunityFilters {
  const body = Object.fromEntries(query.entries());
  const validator = new Validator(body);
  const filters: OpportunityFilters = {
    originRegion: validator.string("originRegion", { optional: true, max: 8 }).toUpperCase(),
    destinationRegion: validator
      .string("destinationRegion", { optional: true, max: 8 })
      .toUpperCase(),
    pickupFrom: validator.date("pickupFrom", { optional: true }),
    pickupTo: validator.date("pickupTo", { optional: true }),
    equipment: validator.string("equipment", { optional: true, max: 20 }),
    cargoType: validator.string("cargoType", { optional: true, max: 30 }),
    minPriceCents: validator.usdCents("minPrice", { optional: true }),
    maxMiles: validator.integer("maxMiles", { optional: true, min: 0, max: 20_000 }) || null,
  };
  if (
    filters.equipment &&
    !EQUIPMENT_TYPES.includes(filters.equipment as (typeof EQUIPMENT_TYPES)[number])
  ) {
    throw badRequest("Unknown equipment filter", { equipment: "Unknown equipment" });
  }
  if (
    filters.cargoType &&
    !CARGO_TYPES.includes(filters.cargoType as (typeof CARGO_TYPES)[number])
  ) {
    throw badRequest("Unknown cargo filter", { cargoType: "Unknown cargo type" });
  }
  validator.done();
  return filters;
}

export function listOpportunities(
  store: Store,
  principal: Principal,
  filters: OpportunityFilters,
): Opportunity[] {
  const company = requireCompany(principal, "supplier");
  const record = store.getSupplierRecord(company.id);
  if (!record) throw badRequest("Complete your supplier profile to see matching shipments");

  const visible = store
    .listPostedShipments()
    .filter((shipment) => canSupplierSee(store, shipment, company.id))
    .filter((shipment) => matchesFilters(shipment, filters));

  const ranked = rankOpportunities(visible, record);
  const comparables = store.listComparableAwards();

  // Seeing an opportunity is what makes a non-response meaningful in matching.
  store.bumpSupplierStats(company.id, { opportunitiesSeen: ranked.length });

  return ranked.map(({ shipment, match }) => {
    const myQuote = store.findQuote(shipment.id, company.id);
    return {
      shipment,
      match,
      rateBand: suggestRate(shipment, comparables),
      estimatedMiles: laneMiles(regionKey(shipment.origin), regionKey(shipment.destination)),
      quoteCount: store.listQuotesForShipment(shipment.id).length,
      myQuote: myQuote
        ? {
            id: myQuote.id,
            status: myQuote.status,
            priceCents: myQuote.priceCents,
            transitDays: myQuote.transitDays,
          }
        : null,
    };
  });
}

function matchesFilters(shipment: Shipment, filters: OpportunityFilters): boolean {
  const origin = regionKey(shipment.origin);
  const destination = regionKey(shipment.destination);
  if (filters.originRegion && origin !== filters.originRegion) return false;
  if (filters.destinationRegion && destination !== filters.destinationRegion) return false;
  if (filters.equipment && shipment.equipment !== filters.equipment) return false;
  if (filters.cargoType && shipment.cargoType !== filters.cargoType) return false;
  if (filters.pickupFrom && shipment.pickupTo < filters.pickupFrom) return false;
  if (filters.pickupTo && shipment.pickupFrom > filters.pickupTo) return false;
  if (filters.minPriceCents !== null) {
    // A shipment with no stated target cannot be excluded by a price floor.
    if (shipment.targetPriceCents !== null && shipment.targetPriceCents < filters.minPriceCents)
      return false;
  }
  if (filters.maxMiles !== null) {
    const miles = laneMiles(origin, destination);
    if (miles !== null && miles > filters.maxMiles) return false;
  }
  return true;
}
