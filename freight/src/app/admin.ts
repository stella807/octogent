/**
 * Platform administration: the trust decisions a marketplace cannot automate
 * away. Verification is a human call recorded with a note, and the note is
 * shown to the company it is about.
 */

import { VERIFICATION_STATUSES } from "../domain/types.ts";
import type { Company } from "../domain/types.ts";
import { Validator } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import { notFound } from "./errors.ts";
import { requireAdmin } from "./principal.ts";
import type { Principal } from "./principal.ts";

export function listCompanies(store: Store, principal: Principal): Company[] {
  requireAdmin(principal);
  return store.listCompanies();
}

export function setVerification(
  store: Store,
  principal: Principal,
  companyId: string,
  body: unknown,
): Company {
  requireAdmin(principal);
  const validator = new Validator(body);
  const status = validator.oneOf("status", VERIFICATION_STATUSES);
  const notes = validator.string("notes", { optional: true, max: 1000 });
  validator.done();
  const updated = store.setVerification(companyId, status, notes);
  if (!updated) throw notFound("Company not found");
  return updated;
}

export type PlatformStats = {
  companies: { shippers: number; suppliers: number; pendingVerification: number };
  shipments: Record<string, number>;
  quotes: { total: number; open: number; accepted: number };
  awardedValueCents: number;
};

export function platformStats(store: Store, principal: Principal): PlatformStats {
  requireAdmin(principal);
  const companies = store.listCompanies();
  const shipments = store.listAllShipments();
  const byStatus: Record<string, number> = {};
  let awardedValueCents = 0;
  let total = 0;
  let open = 0;
  let accepted = 0;

  for (const shipment of shipments) {
    byStatus[shipment.status] = (byStatus[shipment.status] ?? 0) + 1;
    for (const quote of store.listQuotesForShipment(shipment.id)) {
      total += 1;
      if (quote.status === "pending" || quote.status === "countered") open += 1;
      if (quote.status === "accepted") {
        accepted += 1;
        awardedValueCents += quote.priceCents;
      }
    }
  }

  return {
    companies: {
      shippers: companies.filter((company) => company.kind === "shipper").length,
      suppliers: companies.filter((company) => company.kind === "supplier").length,
      pendingVerification: companies.filter((company) => company.verificationStatus === "pending")
        .length,
    },
    shipments: byStatus,
    quotes: { total, open, accepted },
    awardedValueCents,
  };
}
