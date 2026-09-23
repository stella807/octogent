/**
 * Per-shipment messaging between the shipper and one supplier.
 *
 * A thread exists only where a real relationship does: the supplier can see
 * the shipment, or has quoted it. That keeps the marketplace from turning into
 * a cold-outreach channel.
 */

import type { Message } from "../domain/types.ts";
import { Validator } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import { forbidden, notFound } from "./errors.ts";
import type { Principal } from "./principal.ts";
import { canSupplierSee } from "./shipments.ts";

export type ThreadView = {
  shipmentId: string;
  supplierCompanyId: string;
  supplierName: string;
  shipperName: string;
  messages: (Message & { senderName: string; senderCompanyName: string })[];
};

function resolveThread(
  store: Store,
  principal: Principal,
  shipmentId: string,
  supplierCompanyId: string,
): { shipperCompanyId: string } {
  const shipment = store.getShipment(shipmentId);
  if (!shipment) throw notFound("Shipment not found");
  const company = principal.company;
  if (!company) throw forbidden();

  if (company.id === shipment.shipperCompanyId) {
    const supplier = store.getCompany(supplierCompanyId);
    if (!supplier || supplier.kind !== "supplier") throw notFound("Supplier not found");
    return { shipperCompanyId: shipment.shipperCompanyId };
  }
  if (company.id !== supplierCompanyId) throw forbidden("You are not part of this conversation");
  if (!canSupplierSee(store, shipment, company.id))
    throw forbidden("That shipment is not open to you");
  return { shipperCompanyId: shipment.shipperCompanyId };
}

export function listThread(
  store: Store,
  principal: Principal,
  shipmentId: string,
  supplierCompanyId: string,
): ThreadView {
  const { shipperCompanyId } = resolveThread(store, principal, shipmentId, supplierCompanyId);
  const messages = store.listMessages(shipmentId, supplierCompanyId).map((message) => {
    const sender = store.getUserById(message.senderUserId);
    const senderCompany = store.getCompany(message.senderCompanyId);
    return {
      ...message,
      senderName: sender?.name ?? "Unknown",
      senderCompanyName: senderCompany?.name ?? "Unknown",
    };
  });
  return {
    shipmentId,
    supplierCompanyId,
    supplierName: store.getCompany(supplierCompanyId)?.name ?? "Unknown supplier",
    shipperName: store.getCompany(shipperCompanyId)?.name ?? "Unknown shipper",
    messages,
  };
}

export function sendMessage(
  store: Store,
  principal: Principal,
  shipmentId: string,
  supplierCompanyId: string,
  body: unknown,
): Message {
  resolveThread(store, principal, shipmentId, supplierCompanyId);
  const validator = new Validator(body);
  const text = validator.string("body", { min: 1, max: 4000 });
  validator.done();
  const company = principal.company;
  if (!company) throw forbidden();
  return store.addMessage({
    shipmentId,
    supplierCompanyId,
    senderUserId: principal.user.id,
    senderCompanyId: company.id,
    body: text,
    createdAt: new Date().toISOString(),
  });
}
