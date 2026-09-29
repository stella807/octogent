/**
 * The platform's commission: the rate, and the ledger of what it has recorded.
 *
 * Two things this deliberately does not do. It does not move money — there is
 * no payment processor here, so a commission is an amount owed, not an amount
 * taken. And it never recalculates a past booking: each one stored the rate in
 * force when it was made, so changing the rate today cannot rewrite what a
 * completed job owed last month.
 */

import type { Booking } from "../domain/types.ts";
import { Validator } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import { decorate } from "./bookings.ts";
import type { BookingListing } from "./bookings.ts";
import type { Principal } from "./principal.ts";
import { requireAdmin } from "./principal.ts";
import { resolveScope } from "./scope.ts";

const COMMISSION_KEY = "commission_bps";

/**
 * 8% by default, charged to the supplier on the booked amount — free to list,
 * pay only on capacity actually sold. An admin can change it; the change only
 * affects bookings made afterwards.
 */
export const DEFAULT_COMMISSION_BPS = 800;

export function commissionBps(store: Store): number {
  const stored = store.getSetting(COMMISSION_KEY);
  if (stored === null) return DEFAULT_COMMISSION_BPS;
  const parsed = Number(stored);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(10_000, Math.round(parsed)))
    : DEFAULT_COMMISSION_BPS;
}

export function setCommissionBps(
  store: Store,
  principal: Principal,
  body: unknown,
): { rateBps: number } {
  requireAdmin(principal);
  const validator = new Validator(body);
  // Basis points, so a quarter of a percent is expressible without floats.
  const rateBps = validator.integer("rateBps", { min: 0, max: 3_000 });
  validator.done();
  store.setSetting(COMMISSION_KEY, String(rateBps));
  return { rateBps };
}

export type CommissionLedger = {
  scope: "shipper" | "supplier" | "admin";
  currentRateBps: number;
  /** What the viewer is party to: bookings they made, sold, or all of them. */
  entries: BookingListing[];
  totals: {
    bookings: number;
    grossCents: number;
    commissionCents: number;
    cancelledCents: number;
  };
  bySupplier: { companyId: string; name: string; grossCents: number; commissionCents: number }[];
};

export function commissionLedger(store: Store, principal: Principal): CommissionLedger {
  const scope = resolveScope(principal);
  const companyId = principal.company?.id ?? "";
  const bookings =
    scope === "admin"
      ? store.listAllBookings()
      : scope === "shipper"
        ? store.listBookingsForShipper(companyId)
        : store.listBookingsForSupplier(companyId);

  const entries = bookings.map((booking) => decorate(store, booking));
  const live = entries.filter((entry) => entry.status === "booked");

  const bySupplier = new Map<
    string,
    { companyId: string; name: string; grossCents: number; commissionCents: number }
  >();
  for (const entry of live) {
    const key = entry.supplierName;
    const current = bySupplier.get(key) ?? {
      companyId: entry.routeId,
      name: entry.supplierName,
      grossCents: 0,
      commissionCents: 0,
    };
    current.grossCents += entry.priceCents;
    current.commissionCents += entry.commissionCents;
    bySupplier.set(key, current);
  }

  return {
    scope,
    currentRateBps: commissionBps(store),
    entries,
    totals: {
      bookings: live.length,
      grossCents: sum(live, (entry) => entry.priceCents),
      commissionCents: sum(live, (entry) => entry.commissionCents),
      cancelledCents: sum(
        entries.filter((entry) => entry.status === "cancelled"),
        (entry) => entry.priceCents,
      ),
    },
    bySupplier: [...bySupplier.values()].sort((a, b) => b.commissionCents - a.commissionCents),
  };
}

function sum<T>(items: T[], read: (item: T) => number): number {
  return items.reduce((total, item) => total + read(item), 0);
}

export type { Booking };
