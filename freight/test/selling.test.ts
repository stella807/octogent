/** Selling capacity: published departures, bookings, and the commission ledger. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { canBook, commissionFor, priceFor, remainingCapacity } from "../src/domain/selling.ts";
import type { Booking, Route } from "../src/domain/types.ts";
import {
  bookingPayload,
  routePayload,
  shipmentPayload,
  shipperRegistration,
  startHarness,
  supplierProfile,
  supplierRegistration,
} from "./helpers.ts";
import type { Client, Harness } from "./helpers.ts";

async function scenario(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await startHarness();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function shipper(harness: Harness, email: string): Promise<Client> {
  const client = harness.client();
  const response = await client.post("/api/auth/register", shipperRegistration(email));
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return client;
}

async function supplier(harness: Harness, email: string, name = "Caribe Lines"): Promise<Client> {
  const client = harness.client();
  await client.post("/api/auth/register", supplierRegistration(email, name));
  const saved = await client.put("/api/supplier/profile", supplierProfile());
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return client;
}

async function adminClient(harness: Harness): Promise<Client> {
  const { seedAdmin } = await import("../src/seed.ts");
  await seedAdmin(harness.store, "admin@selling.example", "a-long-enough-password");
  const client = harness.client();
  const signedIn = await client.post("/api/auth/login", {
    email: "admin@selling.example",
    password: "a-long-enough-password",
  });
  assert.equal(signedIn.status, 201);
  return client;
}

const testRoute = (overrides: Partial<Route> = {}): Route => ({
  id: "rte_1",
  reference: "RTE-TEST01",
  supplierCompanyId: "co_supplier",
  origin: { city: "Miami", region: "FL", country: "US" },
  destination: { city: "San Juan", region: "PR", country: "US" },
  equipment: "dry_van",
  departsOn: "2026-11-10",
  arrivesBy: "2026-11-13",
  bookingCutoff: "2026-11-08",
  capacityPallets: 20,
  capacityWeightLbs: 44_000,
  pricePerPalletCents: 42_000,
  minimumChargeCents: 150_000,
  cargoTypes: ["general_palletized"],
  capabilities: ["port_drayage"],
  notes: "",
  status: "open",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const booked = (
  pallets: number,
  weightLbs: number,
  status: Booking["status"] = "booked",
): Booking => ({
  id: "bkg",
  reference: "BKG-1",
  routeId: "rte_1",
  shipperCompanyId: "co_shipper",
  shipmentId: "shp_1",
  pallets,
  weightLbs,
  cargoType: "general_palletized",
  cargoDescription: "",
  priceCents: 0,
  commissionBps: 800,
  commissionCents: 0,
  status,
  createdAt: "2026-09-02T00:00:00.000Z",
  cancelledAt: null,
});

describe("pricing and capacity", () => {
  it("charges per pallet, with a floor for a small booking", () => {
    assert.equal(priceFor(testRoute(), { pallets: 8 }), 336_000);
    assert.equal(priceFor(testRoute(), { pallets: 1 }), 150_000, "the minimum charge applies");
    assert.equal(priceFor(testRoute(), { pallets: 4 }), 168_000);
  });

  it("counts only bookings that still hold space", () => {
    const remaining = remainingCapacity(testRoute(), [
      booked(6, 12_000),
      booked(5, 9_000, "cancelled"),
    ]);
    assert.deepEqual(remaining, { pallets: 14, weightLbs: 32_000 });
  });

  it("computes commission in whole cents and refuses to exceed the booking", () => {
    assert.equal(commissionFor(336_000, 800), 26_880);
    assert.equal(commissionFor(100_001, 800), 8_000, "rounded half up");
    assert.equal(
      commissionFor(1_000, 20_000),
      1_000,
      "a rate over 100% cannot take more than the job",
    );
    assert.equal(commissionFor(50_000, 0), 0);
  });

  it("gives a reason for every refusal", () => {
    const full = { pallets: 0, weightLbs: 0 };
    const remaining = { pallets: 14, weightLbs: 32_000 };
    const request = {
      pallets: 8,
      weightLbs: 12_000,
      cargoType: "general_palletized" as const,
      requirements: ["port_drayage" as const],
    };
    assert.equal(canBook(testRoute(), request, remaining, "2026-11-01").ok, true);
    assert.match(
      (
        canBook(testRoute({ status: "closed" }), request, remaining, "2026-11-01") as {
          reason: string;
        }
      ).reason,
      /closed/,
    );
    assert.match(
      (canBook(testRoute(), request, remaining, "2026-11-09") as { reason: string }).reason,
      /Booking closed on 2026-11-08/,
    );
    assert.match(
      (canBook(testRoute(), request, full, "2026-11-01") as { reason: string }).reason,
      /0 pallet/,
    );
    assert.match(
      (
        canBook(testRoute(), { ...request, cargoType: "hazmat" }, remaining, "2026-11-01") as {
          reason: string;
        }
      ).reason,
      /does not carry hazmat/,
    );
    assert.match(
      (
        canBook(
          testRoute(),
          { ...request, requirements: ["liftgate"] },
          remaining,
          "2026-11-01",
        ) as {
          reason: string;
        }
      ).reason,
      /does not offer: liftgate/,
    );
  });
});

describe("publishing capacity", () => {
  it("lets a supplier publish a departure and a shipper see it on the board", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "sell@lines.example");
      const desk = await shipper(harness, "buy@acme.example");

      const published = await carrier.post("/api/routes", routePayload());
      assert.equal(published.status, 201, JSON.stringify(published.json));
      assert.match(published.json.reference, /^RTE-[A-Z0-9]{6}$/);
      assert.equal(published.json.status, "open");
      assert.equal(published.json.pricePerPalletCents, 42_000);

      const board = await desk.get("/api/routes");
      assert.equal(board.json.length, 1);
      assert.equal(board.json[0].supplierName, "Caribe Lines");
      assert.deepEqual(board.json[0].remaining, { pallets: 20, weightLbs: 44_000 });
      assert.equal(board.json[0].sellable, true);
      assert.ok(board.json[0].estimatedMiles > 900);
    }));

  it("refuses equipment the supplier does not own", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "noflat@lines.example");
      const refused = await carrier.post("/api/routes", routePayload({ equipment: "flatbed" }));
      assert.equal(refused.status, 422);
      assert.match(refused.json.fields.equipment, /not in your fleet/);
    }));

  it("refuses dates that do not make sense", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "dates@lines.example");
      const backwards = await carrier.post(
        "/api/routes",
        routePayload({ arrivesBy: "2026-11-01" }),
      );
      assert.equal(backwards.status, 422);
      assert.match(backwards.json.fields.arrivesBy, /before departure/);

      const lateCutoff = await carrier.post(
        "/api/routes",
        routePayload({ bookingCutoff: "2026-11-12" }),
      );
      assert.equal(lateCutoff.status, 422);
      assert.match(lateCutoff.json.fields.bookingCutoff, /after the departure/);
    }));

  it("keeps shippers out of publishing and suppliers out of booking", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "roles@lines.example");
      const desk = await shipper(harness, "roles@acme.example");
      const route = await carrier.post("/api/routes", routePayload());

      assert.equal((await desk.post("/api/routes", routePayload())).status, 403);
      assert.equal(
        (await carrier.post(`/api/routes/${route.json.id}/bookings`, bookingPayload())).status,
        403,
      );
    }));
});

describe("booking capacity", () => {
  it("turns a booking into an ordinary awarded shipment", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "book@lines.example");
      const desk = await shipper(harness, "book@acme.example");
      const route = await carrier.post("/api/routes", routePayload());

      const result = await desk.post(`/api/routes/${route.json.id}/bookings`, bookingPayload());
      assert.equal(result.status, 201, JSON.stringify(result.json));
      assert.match(result.json.booking.reference, /^BKG-[A-Z0-9]{6}$/);
      assert.equal(result.json.booking.priceCents, 336_000);
      assert.equal(result.json.booking.commissionBps, 800);
      assert.equal(result.json.booking.commissionCents, 26_880);
      assert.equal(result.json.shipment.status, "awarded");

      // The rest of the platform sees an ordinary shipment.
      const shipment = await desk.get(`/api/shipments/${result.json.shipment.id}`);
      assert.equal(shipment.json.quotes.length, 1);
      assert.equal(shipment.json.quotes[0].status, "accepted");
      assert.equal(shipment.json.quotes[0].priceCents, 336_000);
      assert.equal(shipment.json.shipment.visibility, "invited");

      const floor = (await desk.get("/api/floor")).json;
      assert.equal(floor.stations.find((s: { key: string }) => s.key === "award")?.count, 1);
      const map = (await desk.get("/api/lanes")).json;
      assert.equal(map.lanes.length, 1);
      assert.equal(map.lanes[0].shipments[0].awardedCents, 336_000);

      // And the supplier can move it like any other awarded load.
      const moved = await carrier.post(`/api/shipments/${result.json.shipment.id}/status`, {
        status: "picked_up",
      });
      assert.equal(moved.status, 201, JSON.stringify(moved.json));
    }));

  it("will not oversell a departure", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "full@lines.example");
      const first = await shipper(harness, "first@acme.example");
      const second = await shipper(harness, "second@acme.example");
      const route = await carrier.post("/api/routes", routePayload({ capacityPallets: 10 }));

      const one = await first.post(
        `/api/routes/${route.json.id}/bookings`,
        bookingPayload({ pallets: 8 }),
      );
      assert.equal(one.status, 201);

      const overflow = await second.post(
        `/api/routes/${route.json.id}/bookings`,
        bookingPayload({ pallets: 4 }),
      );
      assert.equal(overflow.status, 409);
      assert.match(overflow.json.error, /Only 2 pallet\(s\) left/);

      const fits = await second.post(
        `/api/routes/${route.json.id}/bookings`,
        bookingPayload({ pallets: 2 }),
      );
      assert.equal(fits.status, 201);

      // Sold out, so it drops off the shipper's board.
      assert.equal((await second.get("/api/routes")).json.length, 0);
      const supplierView = (await carrier.get("/api/routes")).json[0];
      assert.equal(supplierView.remaining.pallets, 0);
      assert.equal(supplierView.booked.count, 2);
      assert.equal(supplierView.sellable, false);
    }));

  it("respects the weight limit as well as the pallet count", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "heavy@lines.example");
      const desk = await shipper(harness, "heavy@acme.example");
      const route = await carrier.post("/api/routes", routePayload({ capacityWeightLbs: 10_000 }));
      const tooHeavy = await desk.post(
        `/api/routes/${route.json.id}/bookings`,
        bookingPayload({ pallets: 2, weightLbs: 12_000 }),
      );
      assert.equal(tooHeavy.status, 409);
      assert.match(tooHeavy.json.error, /10,000 lb left/);
    }));

  it("refuses a booking after the cutoff", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "late@lines.example");
      const desk = await shipper(harness, "late@acme.example");
      const route = await carrier.post(
        "/api/routes",
        routePayload({
          departsOn: "2026-01-10",
          arrivesBy: "2026-01-13",
          bookingCutoff: "2026-01-08",
        }),
      );
      const refused = await desk.post(`/api/routes/${route.json.id}/bookings`, bookingPayload());
      assert.equal(refused.status, 409);
      assert.match(refused.json.error, /Booking closed on 2026-01-08/);
    }));

  it("releases the space when a booking is cancelled", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "cancel@lines.example");
      const desk = await shipper(harness, "cancel@acme.example");
      const route = await carrier.post("/api/routes", routePayload({ capacityPallets: 10 }));
      const result = await desk.post(
        `/api/routes/${route.json.id}/bookings`,
        bookingPayload({ pallets: 10 }),
      );

      assert.equal((await desk.get("/api/routes")).json.length, 0, "sold out");
      const cancelled = await desk.post(`/api/bookings/${result.json.booking.id}/cancel`, {
        note: "Order fell through",
      });
      assert.equal(cancelled.status, 201);
      assert.equal(cancelled.json.status, "cancelled");

      assert.equal(
        (await desk.get("/api/routes")).json.length,
        1,
        "the space is back on the board",
      );
      const shipment = await desk.get(`/api/shipments/${result.json.shipment.id}`);
      assert.equal(shipment.json.shipment.status, "cancelled");
    }));

  it("stops a cancellation once the load has been picked up", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "moving@lines.example");
      const desk = await shipper(harness, "moving@acme.example");
      const route = await carrier.post("/api/routes", routePayload());
      const result = await desk.post(`/api/routes/${route.json.id}/bookings`, bookingPayload());
      await carrier.post(`/api/shipments/${result.json.shipment.id}/status`, {
        status: "picked_up",
      });

      const refused = await desk.post(`/api/bookings/${result.json.booking.id}/cancel`, {});
      assert.equal(refused.status, 409);
      assert.match(refused.json.error, /already picked up/);
    }));

  it("keeps one shipper's booking away from another", async () =>
    scenario(async (harness) => {
      const carrier = await supplier(harness, "privacy@lines.example");
      const mine = await shipper(harness, "mine@acme.example");
      const theirs = await shipper(harness, "theirs@acme.example");
      const route = await carrier.post("/api/routes", routePayload());
      const result = await mine.post(`/api/routes/${route.json.id}/bookings`, bookingPayload());

      assert.equal((await theirs.get("/api/bookings")).json.length, 0);
      assert.equal(
        (await theirs.post(`/api/bookings/${result.json.booking.id}/cancel`, {})).status,
        403,
      );
      assert.equal((await mine.get("/api/bookings")).json.length, 1);
      assert.equal(
        (await carrier.get("/api/bookings")).json.length,
        1,
        "the seller sees what they sold",
      );
    }));
});

describe("the commission ledger", () => {
  it("records what is owed, per booking, at the rate in force", async () =>
    scenario(async (harness) => {
      const admin = await adminClient(harness);
      const carrier = await supplier(harness, "ledger@lines.example");
      const desk = await shipper(harness, "ledger@acme.example");
      const route = await carrier.post("/api/routes", routePayload());
      await desk.post(`/api/routes/${route.json.id}/bookings`, bookingPayload({ pallets: 5 }));

      const ledger = (await admin.get("/api/commission")).json;
      assert.equal(ledger.currentRateBps, 800);
      assert.equal(ledger.totals.bookings, 1);
      assert.equal(ledger.totals.grossCents, 210_000);
      assert.equal(ledger.totals.commissionCents, 16_800);
      assert.equal(ledger.bySupplier[0].name, "Caribe Lines");
      assert.equal(ledger.entries[0].lane, "Miami, FL → San Juan, PR");
    }));

  it("never rewrites a past booking when the rate changes", async () =>
    scenario(async (harness) => {
      const admin = await adminClient(harness);
      const carrier = await supplier(harness, "rate@lines.example");
      const desk = await shipper(harness, "rate@acme.example");
      const route = await carrier.post("/api/routes", routePayload());

      const before = await desk.post(
        `/api/routes/${route.json.id}/bookings`,
        bookingPayload({ pallets: 5 }),
      );
      assert.equal(before.json.booking.commissionBps, 800);

      const changed = await admin.put("/api/admin/commission", { rateBps: 1200 });
      assert.equal(changed.status, 200, JSON.stringify(changed.json));

      const after = await desk.post(
        `/api/routes/${route.json.id}/bookings`,
        bookingPayload({ pallets: 5 }),
      );
      assert.equal(after.json.booking.commissionBps, 1200);
      assert.equal(after.json.booking.commissionCents, 25_200);

      const ledger = (await admin.get("/api/commission")).json;
      const rates = ledger.entries
        .map((entry: { commissionBps: number }) => entry.commissionBps)
        .sort((a: number, b: number) => a - b);
      assert.deepEqual(rates, [800, 1200], "the old booking kept the old rate");
      assert.equal(ledger.totals.commissionCents, 16_800 + 25_200);
    }));

  it("drops the commission when the booking is cancelled", async () =>
    scenario(async (harness) => {
      const admin = await adminClient(harness);
      const carrier = await supplier(harness, "drop@lines.example");
      const desk = await shipper(harness, "drop@acme.example");
      const route = await carrier.post("/api/routes", routePayload());
      const result = await desk.post(`/api/routes/${route.json.id}/bookings`, bookingPayload());
      await desk.post(`/api/bookings/${result.json.booking.id}/cancel`, {});

      const ledger = (await admin.get("/api/commission")).json;
      assert.equal(ledger.totals.bookings, 0);
      assert.equal(ledger.totals.commissionCents, 0);
      assert.equal(ledger.totals.cancelledCents, 336_000);
    }));

  it("shows each party only their own side, and lets only an admin set the rate", async () =>
    scenario(async (harness) => {
      const admin = await adminClient(harness);
      const carrier = await supplier(harness, "scope@lines.example");
      const desk = await shipper(harness, "scope@acme.example");
      const route = await carrier.post("/api/routes", routePayload());
      await desk.post(`/api/routes/${route.json.id}/bookings`, bookingPayload());

      assert.equal((await desk.get("/api/commission")).json.scope, "shipper");
      assert.equal((await carrier.get("/api/commission")).json.totals.commissionCents, 26_880);
      assert.equal((await desk.put("/api/admin/commission", { rateBps: 100 })).status, 403);
      assert.equal((await carrier.put("/api/admin/commission", { rateBps: 100 })).status, 403);
      assert.equal((await admin.put("/api/admin/commission", { rateBps: 100 })).status, 200);
      assert.equal((await admin.put("/api/admin/commission", { rateBps: 9_000 })).status, 422);
    }));
});
