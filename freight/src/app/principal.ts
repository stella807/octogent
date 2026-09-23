import type { Company, User } from "../domain/types.ts";
import { forbidden } from "./errors.ts";

/** The signed-in user plus their company, resolved once per request. */
export type Principal = {
  user: User;
  company: Company | null;
};

export function requireCompany(principal: Principal, kind: Company["kind"]): Company {
  if (principal.user.role === "admin") {
    throw forbidden("Admins do not act as a shipper or supplier; use the admin console");
  }
  if (!principal.company || principal.company.kind !== kind) {
    throw forbidden(`This action is for ${kind} accounts`);
  }
  return principal.company;
}

export function requireAdmin(principal: Principal): void {
  if (principal.user.role !== "admin") throw forbidden("Admin only");
}
