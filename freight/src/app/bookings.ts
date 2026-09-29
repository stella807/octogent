/**
 * Buying space on a published departure, and the commission that records.
 *
 * A booking is not a parallel kind of freight: it creates an ordinary shipment,
 * already awarded to the publishing supplier at the published price, so the
 * command floor, the lane map, status tracking and the delivery record all keep
 * working without knowing bookings exist.
 *
 * Commission is *recorded*, not charged. No money moves through this platform —
 * see the README on what taking payment would require.
 */

import { canBook, commissionFor, priceFor, remainingCapacity } from "../domain/selling.ts";
import { CARGO_TYPES, SPECIAL_REQUIREMENTS } from "../domain/types.ts";
import type { Booking, Route, Shipment } from "../domain/types.ts";
import { Validator } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import { commissionBps } from "./commission.ts";
import { badRequest, conflict, forbidden, notFound } from "./errors.ts";
import type { Principal } from "./principal.ts";
import { requireCompany } from "./principal.ts";
import { resolveScope } from "./scope.ts";

export type BookingResult = { booking: Booking; shipment: Shipment; route: Route };

export function bookRoute(
  store: Store,
  principal: Principal,
  routeId: string,
  body: unknown,
): BookingResult {
  const company = requireCompany(principal, "shipper");

  const validator = new Validator(body);
  const pallets = validator.integer("pallets", { min: 1, max: 200 });
  const weightLbs = validator.integer("weightLbs", { min: 1, max: 200_000 });
  const cargoType = validator.oneOf("cargoType", CARGO_TYPES);
  const cargoDescription = validator.string("cargoDescription", { min: 3, max: 500 });
  const requirements = validator.manyOf("specialRequirements", SPECIAL_REQUIREMENTS);
  validator.done();

  const today = new Date().toISOString().slice(0, 10);

  // One transaction from the capacity check to the commission row: two shippers
  // booking the last pallet at the same moment must not both succeed.
  return store.transaction(() => {
    const route = store.getRoute(routeId);
    if (!route) throw notFound("Route not found");

    const remaining = remainingCapacity(route, store.listBookingsForRoute(route.id));
    const allowed = canBook(
      route,
      { pallets, weightLbs, cargoType, requirements },
      remaining,
      today,
    );
    if (!allowed.ok) throw conflict(allowed.reason);

    const priceCents = priceFor(route, { pallets });
    const rateBps = commissionBps(store);
    const commissionCents = commissionFor(priceCents, rateBps);
    const now = new Date().toISOString();

    const shipment = store.createShipment({
      shipperCompanyId: company.id,
      origin: route.origin,
      destination: route.destination,
      pickupFrom: route.departsOn,
      pickupTo: route.departsOn,
      deliverBy: route.arrivesBy,
      cargoType,
      cargoDescription,
      palletCount: pallets,
      weightLbs,
      dimensionsIn: null,
      equipment: route.equipment,
      specialRequirements: requirements,
      targetPriceCents: priceCents,
      // Bought capacity is nobody else's business, and it was never on offer.
      visibility: "invited",
      invitedCompanyIds: [route.supplierCompanyId],
    });

    const quote = store.createQuote(
      {
        shipmentId: shipment.id,
        supplierCompanyId: route.supplierCompanyId,
        priceCents,
        transitDays: transitDays(route),
        equipment: route.equipment,
        terms: `Booked capacity on ${route.reference}, published price`,
        validUntil: `${route.departsOn}T00:00:00.000Z`,
      },
      {
        actor: "supplier",
        priceCents,
        transitDays: transitDays(route),
        note: `Published price on ${route.reference}`,
        createdAt: now,
      },
    );

    const awarded = store.awardShipment(shipment.id, quote.id, now);
    if (!awarded) throw notFound("Shipment not found");

    const booking = store.createBooking({
      routeId: route.id,
      shipperCompanyId: company.id,
      shipmentId: shipment.id,
      pallets,
      weightLbs,
      cargoType,
      cargoDescription,
      priceCents,
      commissionBps: rateBps,
      commissionCents,
    });

    store.addEvent({
      shipmentId: shipment.id,
      type: "booked",
      actorUserId: principal.user.id,
      detail: `${pallets} pallet(s) on ${route.reference} at ${(priceCents / 100).toFixed(2)} USD`,
      createdAt: now,
    });

    return { booking, shipment: awarded, route };
  });
}

/**
 * Cancelling a booking releases the space and cancels the shipment with it.
 * Once the load is picked up it is no longer a booking question, so the
 * shipment's own rules take over.
 */
export function cancelBooking(
  store: Store,
  principal: Principal,
  bookingId: string,
  body: unknown,
): Booking {
  const company = principal.company;
  if (!company) throw forbidden();

  const validator = new Validator(body);
  const note = validator.string("note", { optional: true, max: 500 });
  validator.done();

  return store.transaction(() => {
    const booking = store.getBooking(bookingId);
    if (!booking) throw notFound("Booking not found");
    const route = store.getRoute(booking.routeId);
    if (!route) throw notFound("Route not found");

    const isShipper = booking.shipperCompanyId === company.id;
    const isSupplier = route.supplierCompanyId === company.id;
    if (!isShipper && !isSupplier && principal.user.role !== "admin") {
      throw forbidden("You are not a party to this booking");
    }
    if (booking.status !== "booked") throw conflict(`This booking is already ${booking.status}`);

    const shipment = store.getShipment(booking.shipmentId);
    if (shipment && shipment.status !== "awarded") {
      throw conflict(
        `The load is already ${shipment.status.replaceAll("_", " ")} — cancel it on the shipment`,
      );
    }

    const now = new Date().toISOString();
    const cancelled = store.setBookingStatus(booking.id, "cancelled", now);
    if (shipment) {
      store.setShipmentStatus(shipment.id, "cancelled", now);
      store.addEvent({
        shipmentId: shipment.id,
        type: "status:cancelled",
        actorUserId: principal.user.id,
        detail: note || `Booking ${booking.reference} cancelled`,
        createdAt: now,
      });
      // The commission goes with it: nothing was carried, so nothing is owed.
      store.bumpSupplierStats(route.supplierCompanyId, { cancellations: 1 });
    }
    if (!cancelled) throw notFound("Booking not found");
    return cancelled;
  });
}

export type BookingListing = Booking & {
  routeReference: string;
  lane: string;
  departsOn: string;
  supplierName: string;
  shipperName: string;
  shipmentStatus: Shipment["status"] | null;
};

export function listBookings(store: Store, principal: Principal): BookingListing[] {
  const scope = resolveScope(principal);
  const companyId = principal.company?.id ?? "";
  const bookings =
    scope === "admin"
      ? store.listAllBookings()
      : scope === "shipper"
        ? store.listBookingsForShipper(companyId)
        : store.listBookingsForSupplier(companyId);

  return bookings.map((booking) => decorate(store, booking));
}

export function decorate(store: Store, booking: Booking): BookingListing {
  const route = store.getRoute(booking.routeId);
  const shipment = store.getShipment(booking.shipmentId);
  return {
    ...booking,
    routeReference: route?.reference ?? "—",
    lane: route
      ? `${route.origin.city}, ${route.origin.region} → ${route.destination.city}, ${route.destination.region}`
      : "—",
    departsOn: route?.departsOn ?? "—",
    supplierName: route ? (store.getCompany(route.supplierCompanyId)?.name ?? "—") : "—",
    shipperName: store.getCompany(booking.shipperCompanyId)?.name ?? "—",
    shipmentStatus: shipment?.status ?? null,
  };
}

function transitDays(route: Route): number {
  const departs = Date.parse(`${route.departsOn}T00:00:00Z`);
  const arrives = Date.parse(`${route.arrivesBy}T00:00:00Z`);
  if (Number.isNaN(departs) || Number.isNaN(arrives)) return 1;
  return Math.max(1, Math.round((arrives - departs) / 86_400_000));
}

export function assertBookable(store: Store, routeId: string): Route {
  const route = store.getRoute(routeId);
  if (!route) throw notFound("Route not found");
  if (route.status !== "open") throw badRequest(`This departure is ${route.status}`);
  return route;
}
