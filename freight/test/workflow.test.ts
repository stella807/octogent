import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Quote } from "../src/domain/types.ts";
import {
  awaiting,
  canAccept,
  canCounter,
  canTransitionShipment,
  isExpired,
  statusAfterCounter,
} from "../src/domain/workflow.ts";

const quote = (overrides: Partial<Quote> = {}): Quote => ({
  id: "qt_1",
  shipmentId: "shp_1",
  supplierCompanyId: "co_supplier",
  status: "pending",
  priceCents: 420_000,
  transitDays: 3,
  equipment: "dry_van",
  terms: "",
  validUntil: "2099-01-01T00:00:00.000Z",
  offers: [],
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-20T12:00:00.000Z",
  ...overrides,
});

describe("shipment status machine", () => {
  it("lets the shipper award and the supplier move the load", () => {
    assert.equal(canTransitionShipment("posted", "awarded", "shipper").ok, true);
    assert.equal(canTransitionShipment("awarded", "picked_up", "supplier").ok, true);
    assert.equal(canTransitionShipment("picked_up", "in_transit", "supplier").ok, true);
    assert.equal(canTransitionShipment("in_transit", "delivered", "supplier").ok, true);
  });

  it("refuses to skip a step", () => {
    const result = canTransitionShipment("posted", "delivered", "supplier");
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /cannot move to delivered/);
  });

  it("refuses a transition made by the wrong party", () => {
    const result = canTransitionShipment("awarded", "picked_up", "shipper");
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /Only supplier/);
  });

  it("closes delivered and cancelled shipments for good", () => {
    assert.equal(canTransitionShipment("delivered", "in_transit", "admin").ok, false);
    assert.equal(canTransitionShipment("cancelled", "posted", "admin").ok, false);
  });

  it("lets a supplier cancel nothing, and an admin cancel a moving load", () => {
    assert.equal(canTransitionShipment("in_transit", "cancelled", "supplier").ok, false);
    assert.equal(canTransitionShipment("in_transit", "cancelled", "admin").ok, true);
  });
});

describe("negotiation turn taking", () => {
  it("waits on the shipper after a supplier quote", () => {
    assert.equal(awaiting(quote()), "shipper");
    assert.equal(canCounter(quote(), "shipper").ok, true);
    assert.equal(canCounter(quote(), "supplier").ok, false);
  });

  it("waits on the supplier after a shipper counter", () => {
    const countered = quote({ status: "countered" });
    assert.equal(awaiting(countered), "supplier");
    assert.equal(canAccept(countered, "supplier").ok, true);
    assert.equal(canAccept(countered, "shipper").ok, false);
  });

  it("flips the turn on every counter", () => {
    assert.equal(statusAfterCounter("shipper"), "countered");
    assert.equal(statusAfterCounter("supplier"), "pending");
  });

  it("stops a settled quote from moving again", () => {
    for (const status of ["accepted", "declined", "withdrawn", "expired"] as const) {
      const settled = quote({ status });
      assert.equal(awaiting(settled), null);
      assert.equal(canCounter(settled, "shipper").ok, false);
    }
  });

  it("knows when an offer has run out", () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    assert.equal(isExpired(quote({ validUntil: "2026-09-24T00:00:00.000Z" }), now), true);
    assert.equal(isExpired(quote({ validUntil: "2026-09-26T00:00:00.000Z" }), now), false);
  });
});
