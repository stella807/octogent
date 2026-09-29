/**
 * Selling capacity: what a booking costs, what is left on a departure, and
 * whether a given load may be put on it.
 *
 * Pure rules, so the same answer comes back whether the caller is the booking
 * endpoint, the map's price label, or a test.
 */

import type { Booking, CargoType, Route, SpecialRequirement } from "./types.ts";

export type BookingRequest = {
  pallets: number;
  weightLbs: number;
  cargoType: CargoType;
  requirements: SpecialRequirement[];
};

export type Remaining = { pallets: number; weightLbs: number };

/** What a booking of this size costs on this route, before any commission. */
export function priceFor(route: Route, request: Pick<BookingRequest, "pallets">): number {
  return Math.max(route.pricePerPalletCents * request.pallets, route.minimumChargeCents);
}

/** Capacity left after the bookings that still hold space. */
export function remainingCapacity(route: Route, bookings: Booking[]): Remaining {
  const live = bookings.filter((booking) => booking.status === "booked");
  return {
    pallets: route.capacityPallets - live.reduce((sum, booking) => sum + booking.pallets, 0),
    weightLbs: route.capacityWeightLbs - live.reduce((sum, booking) => sum + booking.weightLbs, 0),
  };
}

/**
 * The commission this platform records on a booking, in whole cents.
 *
 * Rounded half up, and never more than the booking itself — a rate above 100%
 * is a configuration error, not a charge.
 */
export function commissionFor(priceCents: number, rateBps: number): number {
  const bounded = Math.max(0, Math.min(10_000, Math.round(rateBps)));
  return Math.min(priceCents, Math.round((priceCents * bounded) / 10_000));
}

export type BookabilityFailure = { ok: false; reason: string };

/** Every reason a load cannot go on this departure, checked in one place. */
export function canBook(
  route: Route,
  request: BookingRequest,
  remaining: Remaining,
  today: string,
): { ok: true } | BookabilityFailure {
  if (route.status !== "open") return { ok: false, reason: `This departure is ${route.status}` };
  if (today > route.bookingCutoff) {
    return { ok: false, reason: `Booking closed on ${route.bookingCutoff}` };
  }
  if (request.pallets <= 0) return { ok: false, reason: "Book at least one pallet" };
  if (request.pallets > remaining.pallets) {
    return {
      ok: false,
      reason: `Only ${Math.max(0, remaining.pallets)} pallet(s) left on this departure`,
    };
  }
  if (request.weightLbs > remaining.weightLbs) {
    return {
      ok: false,
      reason: `Only ${Math.max(0, remaining.weightLbs).toLocaleString()} lb left on this departure`,
    };
  }
  if (route.cargoTypes.length > 0 && !route.cargoTypes.includes(request.cargoType)) {
    return {
      ok: false,
      reason: `This service does not carry ${request.cargoType.replaceAll("_", " ")}`,
    };
  }
  const missing = request.requirements.filter(
    (requirement) => !route.capabilities.includes(requirement),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `This service does not offer: ${missing.map((item) => item.replaceAll("_", " ")).join(", ")}`,
    };
  }
  return { ok: true };
}

/** A departure still worth showing on the board. */
export function isSellable(route: Route, remaining: Remaining, today: string): boolean {
  return route.status === "open" && today <= route.bookingCutoff && remaining.pallets > 0;
}
