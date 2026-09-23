/**
 * Posting, viewing and tracking shipments.
 *
 * Visibility is enforced here, not in the UI: a supplier may read a posted
 * shipment only while it is on the marketplace, they were invited to it, or
 * they already quoted it — and once it is awarded, only the winner keeps
 * access.
 */

import { laneMiles, regionKey } from "../domain/geo.ts";
import { rankSuppliers } from "../domain/matching.ts";
import type { MatchResult } from "../domain/matching.ts";
import { suggestRate } from "../domain/rates.ts";
import type { RateBand } from "../domain/rates.ts";
import { SHIPMENT_STATUSES } from "../domain/types.ts";
import type { Company, Quote, Shipment, ShipmentEvent } from "../domain/types.ts";
import { Validator, parseShipmentInput } from "../domain/validation.ts";
import { canTransitionShipment } from "../domain/workflow.ts";
import type { Store } from "../ports/store.ts";
import { badRequest, forbidden, notFound } from "./errors.ts";
import { requireCompany } from "./principal.ts";
import type { Principal } from "./principal.ts";

export type ShipmentView = {
  shipment: Shipment;
  shipperCompany: Pick<Company, "id" | "name" | "verificationStatus" | "place">;
  estimatedMiles: number | null;
  quotes: (Quote & { supplierName: string; supplierVerification: Company["verificationStatus"] })[];
  events: ShipmentEvent[];
  rateBand: RateBand;
  /** Present for the shipper only. */
  matches?: MatchResult[];
  threads?: {
    supplierCompanyId: string;
    supplierName: string;
    lastMessageAt: string;
    count: number;
  }[];
};

export function postShipment(store: Store, principal: Principal, body: unknown): Shipment {
  const company = requireCompany(principal, "shipper");
  const input = parseShipmentInput(body);
  for (const companyId of input.invitedCompanyIds) {
    const invited = store.getCompany(companyId);
    if (!invited || invited.kind !== "supplier") {
      throw badRequest("Invited supplier not found", {
        invitedCompanyIds: `Unknown supplier ${companyId}`,
      });
    }
  }
  const shipment = store.createShipment({ ...input, shipperCompanyId: company.id });
  store.addEvent({
    shipmentId: shipment.id,
    type: "posted",
    actorUserId: principal.user.id,
    detail: `${shipment.origin.city}, ${shipment.origin.region} → ${shipment.destination.city}, ${shipment.destination.region}`,
    createdAt: new Date().toISOString(),
  });
  return shipment;
}

export function canSupplierSee(
  store: Store,
  shipment: Shipment,
  supplierCompanyId: string,
): boolean {
  const quote = store.findQuote(shipment.id, supplierCompanyId);
  if (shipment.status !== "posted") {
    // Only the awarded supplier keeps access to a closed shipment.
    return quote?.status === "accepted";
  }
  if (shipment.visibility === "invited") {
    return shipment.invitedCompanyIds.includes(supplierCompanyId) || quote !== null;
  }
  return true;
}

function assertReadable(store: Store, principal: Principal, shipment: Shipment): void {
  if (principal.user.role === "admin") return;
  const company = principal.company;
  if (!company) throw forbidden();
  if (company.kind === "shipper") {
    if (shipment.shipperCompanyId !== company.id)
      throw forbidden("That shipment belongs to another shipper");
    return;
  }
  if (!canSupplierSee(store, shipment, company.id))
    throw forbidden("That shipment is not open to you");
}

export function listShipments(store: Store, principal: Principal): Shipment[] {
  if (principal.user.role === "admin") return store.listAllShipments();
  const company = principal.company;
  if (!company) return [];
  return company.kind === "shipper"
    ? store.listShipmentsForShipper(company.id)
    : store.listShipmentsForSupplier(company.id);
}

export function getShipmentView(
  store: Store,
  principal: Principal,
  shipmentId: string,
): ShipmentView {
  const shipment = store.getShipment(shipmentId);
  if (!shipment) throw notFound("Shipment not found");
  assertReadable(store, principal, shipment);

  const shipperCompany = store.getCompany(shipment.shipperCompanyId);
  if (!shipperCompany) throw notFound("Shipper company not found");

  const isShipperSide =
    principal.user.role === "admin" || principal.company?.id === shipment.shipperCompanyId;
  const allQuotes = store.listQuotesForShipment(shipment.id);
  const visibleQuotes = isShipperSide
    ? allQuotes
    : allQuotes.filter((quote) => quote.supplierCompanyId === principal.company?.id);

  const view: ShipmentView = {
    shipment,
    shipperCompany: {
      id: shipperCompany.id,
      name: shipperCompany.name,
      verificationStatus: shipperCompany.verificationStatus,
      place: shipperCompany.place,
    },
    estimatedMiles: laneMiles(regionKey(shipment.origin), regionKey(shipment.destination)),
    quotes: visibleQuotes.map((quote) => decorateQuote(store, quote)),
    events: store.listEvents(shipment.id),
    rateBand: suggestRate(shipment, store.listComparableAwards()),
  };

  if (isShipperSide) {
    view.matches = matchSuppliers(store, shipment);
    view.threads = store.listMessageThreads(shipment.id).map((thread) => ({
      ...thread,
      supplierName: store.getCompany(thread.supplierCompanyId)?.name ?? "Unknown supplier",
    }));
  }
  return view;
}

export function decorateQuote(
  store: Store,
  quote: Quote,
): Quote & { supplierName: string; supplierVerification: Company["verificationStatus"] } {
  const supplier = store.getCompany(quote.supplierCompanyId);
  return {
    ...quote,
    supplierName: supplier?.name ?? "Unknown supplier",
    supplierVerification: supplier?.verificationStatus ?? "unverified",
  };
}

/**
 * Ranked suppliers for a shipment. Invited-only shipments rank just the
 * invitees, because showing the shipper a supplier they did not invite would
 * misrepresent who can actually see the load.
 */
export function matchSuppliers(store: Store, shipment: Shipment): MatchResult[] {
  const records = store.listSupplierRecords();
  const pool =
    shipment.visibility === "invited"
      ? records.filter((record) => shipment.invitedCompanyIds.includes(record.company.id))
      : records;
  return rankSuppliers(shipment, pool);
}

export function getMatches(store: Store, principal: Principal, shipmentId: string): MatchResult[] {
  const shipment = store.getShipment(shipmentId);
  if (!shipment) throw notFound("Shipment not found");
  if (principal.user.role !== "admin" && principal.company?.id !== shipment.shipperCompanyId) {
    throw forbidden("Only the shipper sees the match list for their shipment");
  }
  return matchSuppliers(store, shipment);
}

export function updateShipmentStatus(
  store: Store,
  principal: Principal,
  shipmentId: string,
  body: unknown,
): Shipment {
  const shipment = store.getShipment(shipmentId);
  if (!shipment) throw notFound("Shipment not found");

  const validator = new Validator(body);
  const status = validator.oneOf("status", SHIPMENT_STATUSES);
  const note = validator.string("note", { optional: true, max: 500 });
  validator.done();

  const actor = resolveActor(store, principal, shipment);
  const allowed = canTransitionShipment(shipment.status, status, actor);
  if (!allowed.ok) throw badRequest(allowed.reason);

  const now = new Date().toISOString();
  const closed = status === "delivered" || status === "cancelled" ? now : shipment.closedAt;
  const updated = store.setShipmentStatus(shipment.id, status, closed);
  if (!updated) throw notFound("Shipment not found");

  store.addEvent({
    shipmentId: shipment.id,
    type: `status:${status}`,
    actorUserId: principal.user.id,
    detail: note,
    createdAt: now,
  });

  // Performance counters are the only source matching trusts, so they move here.
  const awardedQuote = shipment.awardedQuoteId ? store.getQuote(shipment.awardedQuoteId) : null;
  if (awardedQuote) {
    if (status === "delivered") {
      const onTime = shipment.deliverBy === null || now.slice(0, 10) <= shipment.deliverBy;
      store.bumpSupplierStats(awardedQuote.supplierCompanyId, {
        completedShipments: 1,
        onTimeDeliveries: onTime ? 1 : 0,
        lateDeliveries: onTime ? 0 : 1,
      });
    }
    if (status === "cancelled" && shipment.status !== "posted") {
      store.bumpSupplierStats(awardedQuote.supplierCompanyId, { cancellations: 1 });
    }
  }
  return updated;
}

function resolveActor(
  store: Store,
  principal: Principal,
  shipment: Shipment,
): "shipper" | "supplier" | "admin" {
  if (principal.user.role === "admin") return "admin";
  const company = principal.company;
  if (!company) throw forbidden();
  if (company.id === shipment.shipperCompanyId) return "shipper";
  const awardedQuote = shipment.awardedQuoteId ? store.getQuote(shipment.awardedQuoteId) : null;
  if (awardedQuote && awardedQuote.supplierCompanyId === company.id) return "supplier";
  throw forbidden("You are not a party to this shipment");
}
