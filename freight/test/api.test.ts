/** End-to-end over real HTTP: post a load, match, bid, negotiate, award, deliver. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  shipmentPayload,
  shipperRegistration,
  startHarness,
  supplierProfile,
  supplierRegistration,
} from "./helpers.ts";
import type { Harness } from "./helpers.ts";
import type { Client } from "./helpers.ts";

/** Every test gets its own server and database, so one test's loads never show up in another's board. */
async function scenario(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await startHarness();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function signedInShipper(harness: Harness, email: string): Promise<Client> {
  const client = harness.client();
  const response = await client.post("/api/auth/register", shipperRegistration(email));
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return client;
}

async function signedInSupplier(
  harness: Harness,
  email: string,
  name: string,
  profile = supplierProfile(),
): Promise<Client> {
  const client = harness.client();
  const response = await client.post("/api/auth/register", supplierRegistration(email, name));
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const saved = await client.put("/api/supplier/profile", profile);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return client;
}

describe("the full shipper → supplier workflow", () => {
  it("runs from posting to delivery", async () =>
    scenario(async (harness) => {
      const shipper = await signedInShipper(harness, "ops@acme.example");
      const supplier = await signedInSupplier(
        harness,
        "dispatch@caribe.example",
        "Caribe Carriers",
      );

      // 1. The shipper posts a load.
      const posted = await shipper.post("/api/shipments", shipmentPayload());
      assert.equal(posted.status, 201, JSON.stringify(posted.json));
      const shipmentId = posted.json.id as string;
      assert.equal(posted.json.status, "posted");
      assert.match(posted.json.reference, /^SHP-[A-Z0-9]{6}$/);

      // 2. Matching ranks the supplier and shows its reasoning.
      const matches = await shipper.get(`/api/shipments/${shipmentId}/matches`);
      assert.equal(matches.status, 200);
      assert.equal(matches.json.length, 1);
      assert.equal(matches.json[0].eligible, true);
      assert.ok(matches.json[0].matchPercent > 50);
      assert.equal(matches.json[0].factors.length, 9);

      // 3. The supplier sees it on the opportunity board, with a rate band.
      const board = await supplier.get("/api/opportunities");
      assert.equal(board.status, 200);
      assert.equal(board.json.length, 1);
      assert.equal(board.json[0].shipment.id, shipmentId);
      assert.ok(board.json[0].rateBand.lowCents < board.json[0].rateBand.highCents);
      assert.equal(board.json[0].myQuote, null);

      // 4. The supplier quotes above the shipper's target.
      const quoted = await supplier.post(`/api/shipments/${shipmentId}/quotes`, {
        price: 5200,
        transitDays: 3,
        equipment: "dry_van",
        terms: "Net 30, detention after 2 hours",
        note: "Space on Thursday's sailing",
      });
      assert.equal(quoted.status, 201, JSON.stringify(quoted.json));
      const quoteId = quoted.json.id as string;
      assert.equal(quoted.json.status, "pending");
      assert.equal(quoted.json.priceCents, 520_000);

      // 5. The shipper counters; the turn passes back to the supplier.
      const countered = await shipper.post(`/api/quotes/${quoteId}/counter`, {
        price: 4600,
        transitDays: 3,
        note: "We can meet you at 4,600",
      });
      assert.equal(countered.status, 201, JSON.stringify(countered.json));
      assert.equal(countered.json.status, "countered");
      assert.equal(countered.json.priceCents, 460_000);
      assert.equal(countered.json.offers.length, 2);

      // The shipper cannot counter their own counter.
      const doubleCounter = await shipper.post(`/api/quotes/${quoteId}/counter`, {
        price: 4500,
        transitDays: 3,
      });
      assert.equal(doubleCounter.status, 409);
      assert.match(doubleCounter.json.error, /Waiting on the supplier/);

      // 6. The supplier accepts, which awards the shipment.
      const accepted = await supplier.post(`/api/quotes/${quoteId}/accept`);
      assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
      assert.equal(accepted.json.quote.status, "accepted");
      assert.equal(accepted.json.shipment.status, "awarded");
      assert.equal(accepted.json.shipment.awardedQuoteId, quoteId);

      // 7. The supplier moves the load; the shipper cannot do it for them.
      const shipperPickup = await shipper.post(`/api/shipments/${shipmentId}/status`, {
        status: "picked_up",
      });
      assert.equal(shipperPickup.status, 400);
      assert.match(shipperPickup.json.error, /Only supplier/);

      for (const status of ["picked_up", "in_transit", "delivered"]) {
        const moved = await supplier.post(`/api/shipments/${shipmentId}/status`, { status });
        assert.equal(moved.status, 201, JSON.stringify(moved.json));
        assert.equal(moved.json.status, status);
      }

      // 8. Delivery feeds the supplier's performance record, which matching reads.
      const board2 = await supplier.get("/api/opportunities");
      assert.equal(board2.json.length, 0, "an awarded shipment leaves the board");

      const detail = await shipper.get(`/api/shipments/${shipmentId}`);
      assert.equal(detail.json.shipment.status, "delivered");
      const eventTypes = detail.json.events.map((event: { type: string }) => event.type);
      assert.deepEqual(eventTypes, [
        "posted",
        "quote:submitted",
        "quote:countered",
        "awarded",
        "status:picked_up",
        "status:in_transit",
        "status:delivered",
      ]);
    }));
});

describe("competing quotes", () => {
  it("awards one supplier and declines the rest", async () =>
    scenario(async (harness) => {
      const shipper = await signedInShipper(harness, "ops2@acme.example");
      const fast = await signedInSupplier(harness, "fast@lines.example", "Fast Lines");
      const cheap = await signedInSupplier(harness, "cheap@lines.example", "Cheap Lines");

      const posted = await shipper.post("/api/shipments", shipmentPayload());
      const shipmentId = posted.json.id as string;

      await fast.post(`/api/shipments/${shipmentId}/quotes`, {
        price: 5000,
        transitDays: 2,
        equipment: "dry_van",
      });
      const cheapQuote = await cheap.post(`/api/shipments/${shipmentId}/quotes`, {
        price: 4200,
        transitDays: 4,
        equipment: "dry_van",
      });

      const comparison = await shipper.get(`/api/shipments/${shipmentId}`);
      assert.equal(comparison.json.quotes.length, 2);
      assert.equal(comparison.json.quotes[0].priceCents, 420_000, "cheapest first");
      assert.ok(comparison.json.quotes[0].supplierName);

      const awarded = await shipper.post(`/api/quotes/${cheapQuote.json.id}/accept`);
      assert.equal(awarded.status, 201);

      const after = await shipper.get(`/api/shipments/${shipmentId}`);
      const statuses = after.json.quotes.map((quote: { status: string }) => quote.status).sort();
      assert.deepEqual(statuses, ["accepted", "declined"]);

      // The losing supplier can no longer read the shipment.
      const closedOut = await fast.get(`/api/shipments/${shipmentId}`);
      assert.equal(closedOut.status, 403);
    }));

  it("refuses a second quote from the same supplier", async () =>
    scenario(async (harness) => {
      const shipper = await signedInShipper(harness, "ops3@acme.example");
      const supplier = await signedInSupplier(harness, "solo@lines.example", "Solo Lines");
      const posted = await shipper.post("/api/shipments", shipmentPayload());
      await supplier.post(`/api/shipments/${posted.json.id}/quotes`, {
        price: 4800,
        transitDays: 3,
        equipment: "dry_van",
      });
      const second = await supplier.post(`/api/shipments/${posted.json.id}/quotes`, {
        price: 4700,
        transitDays: 3,
        equipment: "dry_van",
      });
      assert.equal(second.status, 409);
      assert.match(second.json.error, /counter it instead/);
    }));

  it("refuses a quote from a supplier the shipment excludes", async () =>
    scenario(async (harness) => {
      const shipper = await signedInShipper(harness, "ops4@acme.example");
      const flatbedOnly = await signedInSupplier(
        harness,
        "flat@lines.example",
        "Flatbed Only",
        supplierProfile({ equipment: ["flatbed"], cargoTypes: ["building_materials"] }),
      );
      const posted = await shipper.post("/api/shipments", shipmentPayload());
      const attempt = await flatbedOnly.post(`/api/shipments/${posted.json.id}/quotes`, {
        price: 4000,
        transitDays: 3,
        equipment: "flatbed",
      });
      assert.equal(attempt.status, 400);
      assert.match(attempt.json.error, /does not meet this shipment's requirements/);
    }));
});

describe("private shipments", () => {
  it("is invisible to suppliers who were not invited", async () =>
    scenario(async (harness) => {
      const shipper = await signedInShipper(harness, "ops5@acme.example");
      const invited = await signedInSupplier(harness, "invited@lines.example", "Invited Lines");
      const other = await signedInSupplier(harness, "other@lines.example", "Other Lines");

      const directory = await shipper.get("/api/suppliers");
      const invitedCompany = directory.json.find(
        (entry: { name: string }) => entry.name === "Invited Lines",
      );
      assert.ok(invitedCompany, "the invite picker lists suppliers");
      assert.equal(invitedCompany.contactEmail, undefined, "the picker leaks no contact details");

      const posted = await shipper.post(
        "/api/shipments",
        shipmentPayload({ visibility: "invited", invitedCompanyIds: [invitedCompany.id] }),
      );
      assert.equal(posted.status, 201, JSON.stringify(posted.json));

      assert.equal((await invited.get("/api/opportunities")).json.length, 1);
      assert.equal((await other.get("/api/opportunities")).json.length, 0);
      assert.equal((await other.get(`/api/shipments/${posted.json.id}`)).status, 403);

      const matches = await shipper.get(`/api/shipments/${posted.json.id}/matches`);
      assert.equal(matches.json.length, 1, "matching ranks only the invitees");
    }));
});

describe("messaging", () => {
  it("keeps a private thread per shipper–supplier pair", async () =>
    scenario(async (harness) => {
      const shipper = await signedInShipper(harness, "ops6@acme.example");
      const supplier = await signedInSupplier(harness, "chat@lines.example", "Chat Lines");
      const eavesdropper = await signedInSupplier(harness, "nosy@lines.example", "Nosy Lines");

      const posted = await shipper.post("/api/shipments", shipmentPayload());
      const shipmentId = posted.json.id as string;
      const me = await supplier.get("/api/me");
      const supplierId = me.json.company.id as string;

      const asked = await supplier.post(`/api/shipments/${shipmentId}/threads/${supplierId}`, {
        body: "Is the pickup appointment flexible?",
      });
      assert.equal(asked.status, 201);
      const answered = await shipper.post(`/api/shipments/${shipmentId}/threads/${supplierId}`, {
        body: "Yes, anytime Monday.",
      });
      assert.equal(answered.status, 201);

      const thread = await supplier.get(`/api/shipments/${shipmentId}/threads/${supplierId}`);
      assert.equal(thread.json.messages.length, 2);
      assert.equal(thread.json.messages[0].senderName, "Sam Dispatch");

      const snooped = await eavesdropper.get(`/api/shipments/${shipmentId}/threads/${supplierId}`);
      assert.equal(snooped.status, 403);

      const threads = await shipper.get(`/api/shipments/${shipmentId}`);
      assert.equal(threads.json.threads.length, 1);
      assert.equal(threads.json.threads[0].count, 2);
    }));
});

describe("opportunity filters", () => {
  it("filters the board by lane, equipment and date", async () =>
    scenario(async (harness) => {
      const shipper = await signedInShipper(harness, "ops7@acme.example");
      const supplier = await signedInSupplier(harness, "filter@lines.example", "Filter Lines");
      await shipper.post("/api/shipments", shipmentPayload());
      await shipper.post(
        "/api/shipments",
        shipmentPayload({
          originCity: "Jacksonville",
          pickupFrom: "2026-11-02",
          pickupTo: "2026-11-03",
          deliverBy: "2026-11-10",
          cargoType: "refrigerated_food",
          equipment: "reefer",
        }),
      );

      assert.equal((await supplier.get("/api/opportunities")).json.length, 2);
      assert.equal((await supplier.get("/api/opportunities?equipment=reefer")).json.length, 1);
      assert.equal((await supplier.get("/api/opportunities?originRegion=US-FL")).json.length, 2);
      assert.equal((await supplier.get("/api/opportunities?originRegion=US-TX")).json.length, 0);
      assert.equal((await supplier.get("/api/opportunities?pickupFrom=2026-11-01")).json.length, 1);
      assert.equal((await supplier.get("/api/opportunities?maxMiles=100")).json.length, 0);

      const badFilter = await supplier.get("/api/opportunities?equipment=hovercraft");
      assert.equal(badFilter.status, 400);
    }));
});

describe("admin", () => {
  it("verifies companies and reports platform totals", async () => {
    const localHarness = await startHarness();
    try {
      const admin = localHarness.client();
      // Admin accounts are seeded, not self-registered.
      const { seedAdmin } = await import("../src/seed.ts");
      await seedAdmin(localHarness.store, "admin@marketplace.example", "a-long-enough-password");
      const signedIn = await admin.post("/api/auth/login", {
        email: "admin@marketplace.example",
        password: "a-long-enough-password",
      });
      assert.equal(signedIn.status, 201);

      const shipper = localHarness.client();
      await shipper.post("/api/auth/register", shipperRegistration("ops@verify.example"));
      const shipperMe = await shipper.get("/api/me");
      assert.equal(shipperMe.json.company.verificationStatus, "pending");

      const denied = await shipper.get("/api/admin/companies");
      assert.equal(denied.status, 403);

      const companies = await admin.get("/api/admin/companies");
      assert.equal(companies.status, 200);
      assert.equal(companies.json.length, 1);

      const verified = await admin.post(
        `/api/admin/companies/${companies.json[0].id}/verification`,
        {
          status: "verified",
          notes: "W-9 and certificate of insurance on file",
        },
      );
      assert.equal(verified.status, 201);
      assert.equal(verified.json.verificationStatus, "verified");

      const stats = await admin.get("/api/admin/stats");
      assert.equal(stats.json.companies.shippers, 1);
      assert.equal(stats.json.companies.pendingVerification, 0);
    } finally {
      await localHarness.close();
    }
  });
});
