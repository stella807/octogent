/**
 * Publishing and browsing capacity for sale.
 *
 * A route is a supplier saying "this departure exists, it has this much space,
 * and the space costs this much". Publishing one is a declaration that they run
 * the lane, so the only hard check is that the equipment is in their fleet —
 * the marketplace does not second-guess a carrier about its own schedule.
 */

import { placeMiles } from "../domain/geo.ts";
import { canBook, isSellable, priceFor, remainingCapacity } from "../domain/selling.ts";
import type { Remaining } from "../domain/selling.ts";
import {
  CARGO_TYPES,
  EQUIPMENT_TYPES,
  ROUTE_STATUSES,
  SPECIAL_REQUIREMENTS,
} from "../domain/types.ts";
import type { Booking, Route } from "../domain/types.ts";
import { Validator } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import { badRequest, conflict, forbidden, notFound } from "./errors.ts";
import { endpointOf } from "./lanes.ts";
import type { LaneEndpoint } from "./lanes.ts";
import type { Principal } from "./principal.ts";
import { requireCompany } from "./principal.ts";
import { resolveScope } from "./scope.ts";

export type RouteListing = Route & {
  supplierName: string;
  supplierVerification: string;
  remaining: Remaining;
  estimatedMiles: number | null;
  booked: { count: number; pallets: number };
  /** Price of one pallet and of a full load, so the board can show both. */
  examplePriceCents: number;
  sellable: boolean;
  /** Coordinates so the lane map can draw capacity the same way it draws freight. */
  originPoint: LaneEndpoint | null;
  destinationPoint: LaneEndpoint | null;
};

export function publishRoute(store: Store, principal: Principal, body: unknown): Route {
  const company = requireCompany(principal, "supplier");
  const profile = store.getSupplierProfile(company.id);
  if (!profile) throw badRequest("Publish your capabilities before selling capacity");

  const validator = new Validator(body);
  const origin = validator.place("origin");
  const destination = validator.place("destination");
  const equipment = validator.oneOf("equipment", EQUIPMENT_TYPES);
  const departsOn = validator.date("departsOn");
  const arrivesBy = validator.date("arrivesBy");
  const bookingCutoff = validator.date("bookingCutoff", { optional: true });
  const capacityPallets = validator.integer("capacityPallets", { min: 1, max: 400 });
  const capacityWeightLbs = validator.integer("capacityWeightLbs", { min: 1, max: 200_000 });
  const pricePerPallet = validator.usdCents("pricePerPallet", { min: 1_000 });
  const minimumCharge = validator.usdCents("minimumCharge", { optional: true }) ?? 0;
  const cargoTypes = validator.manyOf("cargoTypes", CARGO_TYPES);
  const capabilities = validator.manyOf("capabilities", SPECIAL_REQUIREMENTS);
  const notes = validator.string("notes", { optional: true, max: 1000 });

  if (departsOn && arrivesBy && arrivesBy < departsOn) {
    validator.errors.arrivesBy ??= "Arrival is before departure";
  }
  if (bookingCutoff && departsOn && bookingCutoff > departsOn) {
    validator.errors.bookingCutoff ??= "Booking cannot close after the departure";
  }
  if (!profile.equipment.includes(equipment)) {
    validator.errors.equipment ??= "That equipment is not in your fleet";
  }
  validator.done();

  return store.createRoute({
    supplierCompanyId: company.id,
    origin,
    destination,
    equipment,
    departsOn,
    arrivesBy,
    // Default the cutoff to the departure itself rather than inventing a lead time.
    bookingCutoff: bookingCutoff || departsOn,
    capacityPallets,
    capacityWeightLbs,
    pricePerPalletCents: pricePerPallet as number,
    minimumChargeCents: minimumCharge,
    cargoTypes,
    capabilities,
    notes,
  });
}

export function setRouteStatus(
  store: Store,
  principal: Principal,
  routeId: string,
  body: unknown,
): Route {
  const company = requireCompany(principal, "supplier");
  const route = store.getRoute(routeId);
  if (!route) throw notFound("Route not found");
  if (route.supplierCompanyId !== company.id)
    throw forbidden("That route belongs to another supplier");

  const validator = new Validator(body);
  const status = validator.oneOf("status", ROUTE_STATUSES);
  validator.done();

  if (status === "cancelled") {
    const live = store
      .listBookingsForRoute(route.id)
      .filter((booking) => booking.status === "booked");
    if (live.length > 0) {
      throw conflict(
        `${live.length} booking(s) are on this departure. Cancel them with the shipper before cancelling the route.`,
      );
    }
  }
  const updated = store.setRouteStatus(route.id, status);
  if (!updated) throw notFound("Route not found");
  return updated;
}

export function decorateRoute(store: Store, route: Route, today: string): RouteListing {
  const bookings = store.listBookingsForRoute(route.id);
  const remaining = remainingCapacity(route, bookings);
  const live = bookings.filter((booking) => booking.status === "booked");
  const supplier = store.getCompany(route.supplierCompanyId);
  return {
    ...route,
    supplierName: supplier?.name ?? "Unknown supplier",
    supplierVerification: supplier?.verificationStatus ?? "unverified",
    remaining,
    estimatedMiles: placeMiles(route.origin, route.destination),
    booked: {
      count: live.length,
      pallets: live.reduce((sum, booking) => sum + booking.pallets, 0),
    },
    examplePriceCents: priceFor(route, { pallets: 1 }),
    sellable: isSellable(route, remaining, today),
    originPoint: endpointOf(route.origin),
    destinationPoint: endpointOf(route.destination),
  };
}

/**
 * The board: everything on sale for a shipper, everything they published for a
 * supplier, everything for an admin.
 */
export function listRoutes(store: Store, principal: Principal): RouteListing[] {
  const scope = resolveScope(principal);
  const today = new Date().toISOString().slice(0, 10);
  const routes =
    scope === "supplier"
      ? store.listRoutesForSupplier(principal.company?.id ?? "")
      : scope === "admin"
        ? store.listAllRoutes()
        : store.listOpenRoutes();

  const listings = routes.map((route) => decorateRoute(store, route, today));
  // A shipper is shopping, so a departure with no space left is noise.
  return scope === "shipper" ? listings.filter((listing) => listing.sellable) : listings;
}

export function getRouteListing(store: Store, principal: Principal, routeId: string): RouteListing {
  const route = store.getRoute(routeId);
  if (!route) throw notFound("Route not found");
  const scope = resolveScope(principal);
  if (scope === "supplier" && route.supplierCompanyId !== principal.company?.id) {
    throw forbidden("That route belongs to another supplier");
  }
  return decorateRoute(store, route, new Date().toISOString().slice(0, 10));
}

/** A dry run of a booking: the price and whether it would be accepted. */
export function quoteBooking(
  store: Store,
  route: Route,
  request: {
    pallets: number;
    weightLbs: number;
    cargoType: Route["cargoTypes"][number];
    requirements: Route["capabilities"];
  },
  bookings: Booking[],
  today: string,
): { priceCents: number; allowed: ReturnType<typeof canBook> } {
  return {
    priceCents: priceFor(route, request),
    allowed: canBook(
      route,
      { ...request, requirements: request.requirements },
      remainingCapacity(route, bookings),
      today,
    ),
  };
}
