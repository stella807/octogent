/** The lane map places freight; it never invents where freight currently is. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { locate } from "../src/domain/geo.ts";
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

async function supplier(harness: Harness, email: string, name: string): Promise<Client> {
  const client = harness.client();
  await client.post("/api/auth/register", supplierRegistration(email, name));
  const saved = await client.put("/api/supplier/profile", supplierProfile());
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return client;
}

describe("placing a shipment on the map", () => {
  it("resolves a known port to city coordinates", () => {
    const located = locate({ city: "San Juan", region: "PR", country: "US" });
    assert.equal(located?.precision, "city");
    assert.equal(located?.lat, 18.47);
    assert.equal(located?.lon, -66.11);
  });

  it("reads through accents, case and the spellings people type", () => {
    const accented = locate({ city: "Mayagüez", region: "PR", country: "US" });
    const plain = locate({ city: "mayaguez", region: "PR", country: "US" });
    assert.deepEqual(accented, { ...plain, label: accented?.label });
    assert.equal(locate({ city: "Ft. Lauderdale", region: "FL", country: "US" })?.lat, 26.12);
    assert.equal(locate({ city: "NYC", region: "NY", country: "US" })?.lon, -74.01);
  });

  it("falls back to the region centroid and says that is what it did", () => {
    const located = locate({ city: "Kissimmee", region: "FL", country: "US" });
    assert.equal(located?.precision, "region");
    assert.equal(located?.label, "Florida");
  });

  it("returns nothing for a region the marketplace does not serve", () => {
    assert.equal(locate({ city: "Lima", region: "LI", country: "PE" }), null);
  });
});

describe("the lane map", () => {
  it("groups shipments into lanes and counts them by stage", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops@lanes.example");
      const carrier = await supplier(harness, "dispatch@lanes.example", "Lane Lines");

      const first = await desk.post("/api/shipments", shipmentPayload());
      await desk.post("/api/shipments", shipmentPayload()); // same lane
      await desk.post("/api/shipments", shipmentPayload({ destinationCity: "Ponce" }));

      const quote = await carrier.post(`/api/shipments/${first.json.id}/quotes`, {
        price: 4800,
        transitDays: 3,
        equipment: "dry_van",
      });
      await desk.post(`/api/quotes/${quote.json.id}/accept`);

      const map = (await desk.get("/api/lanes")).json;
      assert.equal(map.scope, "shipper");
      assert.equal(map.lanes.length, 2, "two distinct destination cities, two lanes");

      const busiest = map.lanes[0];
      assert.equal(busiest.origin.label, "Miami, FL");
      assert.equal(busiest.destination.label, "San Juan, PR");
      assert.equal(busiest.shipments.length, 2);
      assert.equal(busiest.counts.posted, 1);
      assert.equal(busiest.counts.awarded, 1);
      assert.equal(busiest.awardedValueCents, 480_000);
      assert.equal(busiest.crossesWater, true, "Miami to San Juan needs a vessel");
      assert.ok((busiest.estimatedMiles ?? 0) > 900);
      assert.equal(map.totals.shipments, 3);
      assert.equal(map.totals.awardedValueCents, 480_000);
    }));

  it("never reports a position for a load in transit", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops2@lanes.example");
      const carrier = await supplier(harness, "dispatch2@lanes.example", "Transit Lines");
      const posted = await desk.post("/api/shipments", shipmentPayload());
      const quote = await carrier.post(`/api/shipments/${posted.json.id}/quotes`, {
        price: 4800,
        transitDays: 3,
        equipment: "dry_van",
      });
      await desk.post(`/api/quotes/${quote.json.id}/accept`);
      for (const status of ["picked_up", "in_transit"]) {
        await carrier.post(`/api/shipments/${posted.json.id}/status`, { status });
      }

      const map = (await desk.get("/api/lanes")).json;
      const shipment = map.lanes[0].shipments[0];
      assert.equal(shipment.status, "in_transit");
      // The only coordinates in the payload belong to the two endpoints.
      const keys = new Set(Object.keys(shipment));
      for (const invented of ["lat", "lon", "position", "coordinates", "progress", "eta"]) {
        assert.equal(keys.has(invented), false, `a moving load must not carry ${invented}`);
      }
      assert.equal(JSON.stringify(map).includes('"progress"'), false);
    }));

  it("marks an endpoint that is only a region, not a city", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops3@lanes.example");
      await desk.post("/api/shipments", shipmentPayload({ originCity: "Kissimmee" }));

      const map = (await desk.get("/api/lanes")).json;
      assert.equal(map.lanes[0].origin.precision, "region");
      assert.equal(map.lanes[0].origin.label, "Florida");
      assert.equal(map.lanes[0].destination.precision, "city");
      assert.equal(map.totals.regionPrecisionEndpoints, 1);
    }));

  it("collapses two spellings of one city into a single pin", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops4@lanes.example");
      await desk.post("/api/shipments", shipmentPayload({ destinationCity: "Mayagüez" }));
      await desk.post("/api/shipments", shipmentPayload({ destinationCity: "mayaguez" }));

      const map = (await desk.get("/api/lanes")).json;
      assert.equal(map.lanes.length, 1);
      assert.equal(map.lanes[0].shipments.length, 2);
    }));

  it("scopes the map the way the rest of the app scopes the book", async () =>
    scenario(async (harness) => {
      const first = await shipper(harness, "first@lanes.example");
      const second = await shipper(harness, "second@lanes.example");
      const carrier = await supplier(harness, "carrier@lanes.example", "Scoped Lines");
      await first.post("/api/shipments", shipmentPayload());

      assert.equal((await first.get("/api/lanes")).json.lanes.length, 1);
      assert.equal(
        (await second.get("/api/lanes")).json.lanes.length,
        0,
        "another shipper's book stays hidden",
      );
      assert.equal(
        (await carrier.get("/api/lanes")).json.lanes.length,
        1,
        "a supplier sees the open load they are eligible for",
      );
    }));

  it("names the counterparty from the viewer's own side", async () =>
    scenario(async (harness) => {
      const desk = await shipper(harness, "ops5@lanes.example");
      const carrier = await supplier(harness, "dispatch5@lanes.example", "Named Lines");
      const posted = await desk.post("/api/shipments", shipmentPayload());
      const quote = await carrier.post(`/api/shipments/${posted.json.id}/quotes`, {
        price: 4800,
        transitDays: 3,
        equipment: "dry_van",
      });
      await desk.post(`/api/quotes/${quote.json.id}/accept`);

      const shipperSide = (await desk.get("/api/lanes")).json.lanes[0].shipments[0];
      const supplierSide = (await carrier.get("/api/lanes")).json.lanes[0].shipments[0];
      assert.equal(shipperSide.counterpartyName, "Named Lines");
      assert.equal(supplierSide.counterpartyName, "Acme Foods");
    }));

  it("refuses the map to a signed-out visitor", async () =>
    scenario(async (harness) => {
      assert.equal((await harness.client().get("/api/lanes")).status, 401);
    }));
});
