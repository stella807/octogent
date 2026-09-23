/** The command floor reads the same tables the rest of the app writes. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
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

async function supplier(
  harness: Harness,
  email: string,
  name: string,
  profile = supplierProfile(),
): Promise<Client> {
  const client = harness.client();
  await client.post("/api/auth/register", supplierRegistration(email, name));
  const saved = await client.put("/api/supplier/profile", profile);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return client;
}

const stationCount = (floor: { stations: { key: string; count: number }[] }, key: string) =>
  floor.stations.find((station) => station.key === key)?.count;

const metric = (floor: { metrics: { key: string; value: string }[] }, key: string) =>
  floor.metrics.find((entry) => entry.key === key)?.value;

describe("the command floor", () => {
  it("moves a load across the six stations as it actually moves", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops@floor.example");
      const carrier = await supplier(harness, "dispatch@floor.example", "Floor Lines");

      const empty = (await desk.get("/api/floor")).json;
      assert.deepEqual(
        empty.stations.map((station: { key: string }) => station.key),
        ["intake", "match", "quote", "counter", "award", "settle"],
      );
      assert.equal(
        empty.stations.every((station: { state: string }) => station.state === "idle"),
        true,
        "an empty book lights nothing up",
      );

      const posted = await desk.post("/api/shipments", shipmentPayload());
      const shipmentId = posted.json.id as string;

      let floor = (await desk.get("/api/floor")).json;
      assert.equal(stationCount(floor, "intake"), 1);
      assert.equal(stationCount(floor, "match"), 1);
      assert.equal(stationCount(floor, "quote"), 0);
      assert.equal(floor.stations[0].state, "live");

      const quote = await carrier.post(`/api/shipments/${shipmentId}/quotes`, {
        price: 4800,
        transitDays: 3,
        equipment: "dry_van",
      });
      floor = (await desk.get("/api/floor")).json;
      assert.equal(stationCount(floor, "quote"), 1, "a bid waiting on the shipper sits at Quote");
      assert.equal(metric(floor, "awaiting"), "1");

      await desk.post(`/api/quotes/${quote.json.id}/counter`, { price: 4500, transitDays: 3 });
      floor = (await desk.get("/api/floor")).json;
      assert.equal(stationCount(floor, "quote"), 0);
      assert.equal(stationCount(floor, "counter"), 1, "the turn moved to the supplier");
      assert.equal(metric(floor, "awaiting"), "0", "nothing is blocked on the shipper now");

      await carrier.post(`/api/quotes/${quote.json.id}/accept`);
      floor = (await desk.get("/api/floor")).json;
      assert.equal(stationCount(floor, "intake"), 0);
      assert.equal(stationCount(floor, "counter"), 0);
      assert.equal(stationCount(floor, "award"), 1);
      assert.equal(metric(floor, "awarded"), "$4,500");

      for (const status of ["picked_up", "in_transit", "delivered"]) {
        await carrier.post(`/api/shipments/${shipmentId}/status`, { status });
      }
      floor = (await desk.get("/api/floor")).json;
      assert.equal(stationCount(floor, "award"), 0);
      assert.equal(stationCount(floor, "settle"), 1);
      assert.equal(metric(floor, "onTime"), "100%");
    }));

  it("builds a cumulative award curve in award order", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops2@floor.example");
      const carrier = await supplier(harness, "dispatch2@floor.example", "Curve Lines");

      for (const price of [4000, 5000, 6000]) {
        const posted = await desk.post("/api/shipments", shipmentPayload());
        const quote = await carrier.post(`/api/shipments/${posted.json.id}/quotes`, {
          price,
          transitDays: 3,
          equipment: "dry_van",
        });
        await desk.post(`/api/quotes/${quote.json.id}/accept`);
      }

      const floor = (await desk.get("/api/floor")).json;
      assert.deepEqual(
        floor.awardedCurve.map((point: { cumulativeCents: number }) => point.cumulativeCents),
        [400_000, 900_000, 1_500_000],
      );
      for (const point of floor.awardedCurve) {
        assert.match(point.reference, /^SHP-/, "every point names the shipment behind it");
      }
      assert.equal(metric(floor, "awarded"), "$15K");
    }));

  it("shows a supplier only the loads they are eligible for", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops3@floor.example");
      const reefer = await supplier(
        harness,
        "reefer@floor.example",
        "Reefer Only",
        supplierProfile({ equipment: ["reefer"], cargoTypes: ["frozen_food"] }),
      );

      await desk.post("/api/shipments", shipmentPayload()); // dry van
      await desk.post(
        "/api/shipments",
        shipmentPayload({ equipment: "reefer", cargoType: "frozen_food", specialRequirements: [] }),
      );

      const floor = (await reefer.get("/api/floor")).json;
      assert.equal(floor.scope, "supplier");
      assert.equal(stationCount(floor, "intake"), 2, "both loads are visible on the board");
      assert.equal(stationCount(floor, "match"), 1, "only one is theirs to run");
    }));

  it("does not inflate the response-rate denominator matching reads", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops4@floor.example");
      const carrier = await supplier(harness, "poll@floor.example", "Polled Lines");
      await desk.post("/api/shipments", shipmentPayload());

      const before = harness.store.getSupplierStats(
        (await carrier.get("/api/me")).json.company.id as string,
      );
      for (let poll = 0; poll < 5; poll += 1) await carrier.get("/api/floor");
      const after = harness.store.getSupplierStats(
        (await carrier.get("/api/me")).json.company.id as string,
      );
      assert.equal(
        after.opportunitiesSeen,
        before.opportunitiesSeen,
        "a dashboard polling in the background must not count as the supplier seeing work",
      );
    }));

  it("keeps one shipper's book out of another's floor", async () =>
    scenario(async (harness) => {
      const first = await shipper(harness, "first@floor.example");
      const second = await shipper(harness, "second@floor.example");
      await first.post("/api/shipments", shipmentPayload());

      assert.equal(stationCount((await first.get("/api/floor")).json, "intake"), 1);
      assert.equal(stationCount((await second.get("/api/floor")).json, "intake"), 0);
      assert.equal((await second.get("/api/floor")).json.events.length, 0);
    }));

  it("gives an admin the whole platform and every party's events", async () =>
    scenario(async (harness) => {
      const { seedAdmin } = await import("../src/seed.ts");
      await seedAdmin(harness.store, "admin@floor.example", "a-long-enough-password");
      const admin = harness.client();
      await admin.post("/api/auth/login", {
        email: "admin@floor.example",
        password: "a-long-enough-password",
      });

      const desk = await shipper(harness, "ops5@floor.example");
      const carrier = await supplier(harness, "dispatch5@floor.example", "Admin View Lines");
      const posted = await desk.post("/api/shipments", shipmentPayload());
      await carrier.post(`/api/shipments/${posted.json.id}/quotes`, {
        price: 4700,
        transitDays: 3,
        equipment: "dry_van",
      });

      const floor = (await admin.get("/api/floor")).json;
      assert.equal(floor.scope, "admin");
      assert.equal(stationCount(floor, "intake"), 1);
      assert.equal(stationCount(floor, "quote"), 1);
      assert.deepEqual(
        floor.events.map((event: { type: string }) => event.type),
        ["quote:submitted", "posted"],
        "newest first",
      );
      assert.equal(floor.events[0].actorCompanyName, "Admin View Lines");
      assert.match(floor.events[0].reference, /^SHP-/);
    }));

  it("refuses the floor to a signed-out visitor", async () =>
    scenario(async (harness) => {
      assert.equal((await harness.client().get("/api/floor")).status, 401);
    }));
});
