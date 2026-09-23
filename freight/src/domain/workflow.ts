/**
 * State machines for a shipment and for a quote negotiation.
 *
 * Both are pure: they answer "may this actor make this transition", and the
 * application layer does the persistence. Keeping the rules here is what stops
 * a second HTTP route from inventing a different set.
 */

import type { Quote, QuoteStatus, Shipment, ShipmentStatus } from "./types.ts";

export type Actor = "shipper" | "supplier" | "admin";

const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, { to: ShipmentStatus; by: Actor[] }[]> = {
  posted: [
    { to: "awarded", by: ["shipper"] },
    { to: "cancelled", by: ["shipper", "admin"] },
  ],
  awarded: [
    { to: "picked_up", by: ["supplier"] },
    { to: "cancelled", by: ["shipper", "admin"] },
  ],
  picked_up: [
    { to: "in_transit", by: ["supplier"] },
    { to: "cancelled", by: ["admin"] },
  ],
  in_transit: [
    { to: "delivered", by: ["supplier"] },
    { to: "cancelled", by: ["admin"] },
  ],
  delivered: [],
  cancelled: [],
};

export function canTransitionShipment(
  from: ShipmentStatus,
  to: ShipmentStatus,
  actor: Actor,
): { ok: true } | { ok: false; reason: string } {
  const transition = SHIPMENT_TRANSITIONS[from].find((candidate) => candidate.to === to);
  if (!transition) {
    return { ok: false, reason: `A ${from} shipment cannot move to ${to}` };
  }
  if (!transition.by.includes(actor)) {
    return { ok: false, reason: `Only ${transition.by.join(" or ")} can move a shipment to ${to}` };
  }
  return { ok: true };
}

/** Statuses in which a shipment still accepts quotes and negotiation. */
export function isOpenForQuotes(shipment: Shipment): boolean {
  return shipment.status === "posted";
}

/** Whose turn it is on a live negotiation, or null when it is finished. */
export function awaiting(quote: Quote): Actor | null {
  if (quote.status === "pending") return "shipper";
  if (quote.status === "countered") return "supplier";
  return null;
}

export function canCounter(
  quote: Quote,
  actor: Actor,
): { ok: true } | { ok: false; reason: string } {
  const turn = awaiting(quote);
  if (turn === null)
    return { ok: false, reason: `This quote is ${quote.status} and cannot be changed` };
  if (turn !== actor) return { ok: false, reason: `Waiting on the ${turn} to respond` };
  return { ok: true };
}

/** Accepting is always the other side agreeing to the offer currently on the table. */
export function canAccept(
  quote: Quote,
  actor: Actor,
): { ok: true } | { ok: false; reason: string } {
  return canCounter(quote, actor);
}

export function statusAfterCounter(actor: Actor): QuoteStatus {
  return actor === "shipper" ? "countered" : "pending";
}

export function isExpired(quote: Quote, now: Date): boolean {
  const validUntil = Date.parse(quote.validUntil);
  return !Number.isNaN(validUntil) && validUntil < now.getTime();
}
