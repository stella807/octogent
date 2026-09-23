/**
 * Bidding and negotiation.
 *
 * A quote is a thread of offers, alternating between supplier and shipper.
 * Whoever is not the last to move may counter, accept or walk away, and an
 * accept from either side awards the shipment — so a shipper accepting a
 * supplier's price and a supplier accepting the shipper's counter land in the
 * same place.
 */

import { eligibilityFailures } from "../domain/matching.ts";
import { EQUIPMENT_TYPES } from "../domain/types.ts";
import type { Quote, Shipment } from "../domain/types.ts";
import { Validator } from "../domain/validation.ts";
import {
  awaiting,
  canAccept,
  canCounter,
  isExpired,
  isOpenForQuotes,
  statusAfterCounter,
} from "../domain/workflow.ts";
import type { Store } from "../ports/store.ts";
import { badRequest, conflict, forbidden, notFound } from "./errors.ts";
import { requireCompany } from "./principal.ts";
import type { Principal } from "./principal.ts";
import { canSupplierSee, decorateQuote } from "./shipments.ts";

const DEFAULT_VALID_DAYS = 3;

export function submitQuote(
  store: Store,
  principal: Principal,
  shipmentId: string,
  body: unknown,
): Quote {
  const company = requireCompany(principal, "supplier");
  const shipment = store.getShipment(shipmentId);
  if (!shipment) throw notFound("Shipment not found");
  if (!isOpenForQuotes(shipment)) throw conflict("This shipment is no longer accepting quotes");
  if (!canSupplierSee(store, shipment, company.id))
    throw forbidden("That shipment is not open to you");
  if (store.findQuote(shipment.id, company.id)) {
    throw conflict("You already have a quote on this shipment — counter it instead");
  }

  const record = store.getSupplierRecord(company.id);
  if (!record) throw badRequest("Complete your supplier profile before quoting");
  const failures = eligibilityFailures(shipment, record);
  if (failures.length > 0) {
    throw badRequest(
      `Your profile does not meet this shipment's requirements: ${failures.join("; ")}`,
    );
  }

  const validator = new Validator(body);
  const priceCents = validator.usdCents("price", { min: 5_000 }) as number;
  const transitDays = validator.integer("transitDays", { min: 1, max: 60 });
  const equipment = validator.oneOf("equipment", EQUIPMENT_TYPES);
  const terms = validator.string("terms", { optional: true, max: 1000 });
  const note = validator.string("note", { optional: true, max: 1000 });
  const validDays = validator.integer("validDays", { optional: true, min: 1, max: 30 });
  validator.done();

  if (!record.profile.equipment.includes(equipment)) {
    throw badRequest("Quote equipment is not in your fleet", { equipment: "Not in your fleet" });
  }

  const now = new Date();
  const quote = store.createQuote(
    {
      shipmentId: shipment.id,
      supplierCompanyId: company.id,
      priceCents,
      transitDays,
      equipment,
      terms,
      validUntil: new Date(
        now.getTime() + (validDays || DEFAULT_VALID_DAYS) * 86_400_000,
      ).toISOString(),
    },
    { actor: "supplier", priceCents, transitDays, note, createdAt: now.toISOString() },
  );

  const secondsToRespond = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(shipment.createdAt)) / 1000),
  );
  store.bumpSupplierStats(company.id, {
    quotesSubmitted: 1,
    responseSecondsTotal: secondsToRespond,
    responsesCounted: 1,
  });
  store.addEvent({
    shipmentId: shipment.id,
    type: "quote:submitted",
    actorUserId: principal.user.id,
    detail: `${company.name} quoted ${(priceCents / 100).toFixed(2)} USD, ${transitDays} day(s)`,
    createdAt: now.toISOString(),
  });
  return quote;
}

function loadParty(
  store: Store,
  principal: Principal,
  quoteId: string,
): { quote: Quote; shipment: Shipment; side: "shipper" | "supplier" } {
  const quote = store.getQuote(quoteId);
  if (!quote) throw notFound("Quote not found");
  const shipment = store.getShipment(quote.shipmentId);
  if (!shipment) throw notFound("Shipment not found");
  const company = principal.company;
  if (!company) throw forbidden();
  if (company.id === shipment.shipperCompanyId) return { quote, shipment, side: "shipper" };
  if (company.id === quote.supplierCompanyId) return { quote, shipment, side: "supplier" };
  throw forbidden("You are not a party to this negotiation");
}

export function counterQuote(
  store: Store,
  principal: Principal,
  quoteId: string,
  body: unknown,
): Quote {
  const { quote, shipment, side } = loadParty(store, principal, quoteId);
  if (!isOpenForQuotes(shipment)) throw conflict("This shipment is no longer open");
  const now = new Date();
  if (isExpired(quote, now)) throw conflict("This quote has expired");
  const allowed = canCounter(quote, side);
  if (!allowed.ok) throw conflict(allowed.reason);

  const validator = new Validator(body);
  const priceCents = validator.usdCents("price", { min: 5_000 }) as number;
  const transitDays = validator.integer("transitDays", { min: 1, max: 60 });
  const note = validator.string("note", { optional: true, max: 1000 });
  validator.done();

  const updated = store.addOffer(
    quote.id,
    { actor: side, priceCents, transitDays, note, createdAt: now.toISOString() },
    statusAfterCounter(side),
  );
  if (!updated) throw notFound("Quote not found");
  store.addEvent({
    shipmentId: shipment.id,
    type: "quote:countered",
    actorUserId: principal.user.id,
    detail: `${side} countered at ${(priceCents / 100).toFixed(2)} USD, ${transitDays} day(s)`,
    createdAt: now.toISOString(),
  });
  return updated;
}

/** Accepting the offer on the table awards the shipment to that supplier. */
export function acceptQuote(
  store: Store,
  principal: Principal,
  quoteId: string,
): { quote: Quote; shipment: Shipment } {
  const { quote, shipment, side } = loadParty(store, principal, quoteId);
  if (!isOpenForQuotes(shipment))
    throw conflict("This shipment has already been awarded or closed");
  const now = new Date();
  if (isExpired(quote, now)) throw conflict("This quote has expired");
  const allowed = canAccept(quote, side);
  if (!allowed.ok) throw conflict(allowed.reason);

  const awarded = store.awardShipment(shipment.id, quote.id, now.toISOString());
  if (!awarded) throw notFound("Shipment not found");
  store.addEvent({
    shipmentId: shipment.id,
    type: "awarded",
    actorUserId: principal.user.id,
    detail: `Awarded to ${store.getCompany(quote.supplierCompanyId)?.name ?? quote.supplierCompanyId} at ${(quote.priceCents / 100).toFixed(2)} USD`,
    createdAt: now.toISOString(),
  });
  const refreshed = store.getQuote(quote.id);
  if (!refreshed) throw notFound("Quote not found");
  return { quote: refreshed, shipment: awarded };
}

export function declineQuote(
  store: Store,
  principal: Principal,
  quoteId: string,
  body: unknown,
): Quote {
  const { quote, shipment, side } = loadParty(store, principal, quoteId);
  const turn = awaiting(quote);
  if (turn === null) throw conflict(`This quote is already ${quote.status}`);
  const validator = new Validator(body);
  const note = validator.string("note", { optional: true, max: 500 });
  validator.done();

  const now = new Date().toISOString();
  // A supplier walking away withdraws; a shipper saying no declines.
  const status = side === "supplier" ? "withdrawn" : "declined";
  const updated = store.setQuoteStatus(quote.id, status, now);
  if (!updated) throw notFound("Quote not found");
  store.addEvent({
    shipmentId: shipment.id,
    type: `quote:${status}`,
    actorUserId: principal.user.id,
    detail: note,
    createdAt: now,
  });
  return updated;
}

export function listSupplierQuotes(store: Store, principal: Principal) {
  const company = requireCompany(principal, "supplier");
  return store.listQuotesForSupplier(company.id).map((quote) => {
    const shipment = store.getShipment(quote.shipmentId);
    return {
      ...decorateQuote(store, quote),
      awaiting: awaiting(quote),
      shipment: shipment
        ? {
            id: shipment.id,
            reference: shipment.reference,
            origin: shipment.origin,
            destination: shipment.destination,
            pickupFrom: shipment.pickupFrom,
            pickupTo: shipment.pickupTo,
            status: shipment.status,
            equipment: shipment.equipment,
          }
        : null,
    };
  });
}
