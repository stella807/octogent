/**
 * Who is allowed to see which shipments.
 *
 * The floor and the lane map both need the same answer, so it lives here once:
 * a shipper sees their own book, a supplier sees the posted loads open to them
 * plus everything they have bid on, an admin sees the platform.
 */

import type { Shipment } from "../domain/types.ts";
import type { Store } from "../ports/store.ts";
import { forbidden } from "./errors.ts";
import type { Principal } from "./principal.ts";
import { canSupplierSee } from "./shipments.ts";

export type Scope = "shipper" | "supplier" | "admin";

export function resolveScope(principal: Principal): Scope {
  if (principal.user.role === "admin") return "admin";
  const kind = principal.company?.kind;
  if (kind === "shipper" || kind === "supplier") return kind;
  throw forbidden("This account has no company to show a book for");
}

export function scopedShipments(store: Store, scope: Scope, companyId: string | null): Shipment[] {
  if (scope === "admin") return store.listAllShipments();
  if (!companyId) return [];
  if (scope === "shipper") return store.listShipmentsForShipper(companyId);

  // A supplier keeps sight of loads that closed to them, so a lost award still
  // shows on their map and in their tape.
  const bidOn = store.listShipmentsForSupplier(companyId);
  const seen = new Set(bidOn.map((shipment) => shipment.id));
  const open = store
    .listPostedShipments()
    .filter((shipment) => !seen.has(shipment.id) && canSupplierSee(store, shipment, companyId));
  return [...bidOn, ...open];
}
