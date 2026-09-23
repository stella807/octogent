import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { hashPassword, verifyPassword } from "../src/security/passwords.ts";
import { hashToken, newSessionToken, safeEqual } from "../src/security/tokens.ts";
import {
  shipmentPayload,
  shipperRegistration,
  startHarness,
  supplierRegistration,
} from "./helpers.ts";
import type { Harness } from "./helpers.ts";

async function scenario(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await startHarness();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

describe("passwords", () => {
  it("never stores the password itself", async () => {
    const stored = await hashPassword("a-long-enough-password");
    assert.ok(!stored.includes("a-long-enough-password"));
    assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  });

  it("salts every hash", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same-password-here"),
      hashPassword("same-password-here"),
    ]);
    assert.notEqual(first, second);
  });

  it("accepts the right password and rejects everything else", async () => {
    const stored = await hashPassword("a-long-enough-password");
    assert.equal(await verifyPassword("a-long-enough-password", stored), true);
    assert.equal(await verifyPassword("a-long-enough-passworD", stored), false);
    assert.equal(await verifyPassword("", stored), false);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    assert.equal(await verifyPassword("anything", "not-a-hash"), false);
    assert.equal(await verifyPassword("anything", "scrypt$1$1$1$AAAA$AAAA"), false);
  });
});

describe("session tokens", () => {
  it("stores only a hash of the cookie value", () => {
    const { token, tokenHash } = newSessionToken();
    assert.notEqual(token, tokenHash);
    assert.equal(hashToken(token), tokenHash);
    assert.equal(tokenHash.length, 64);
  });

  it("compares in constant time without crashing on length mismatch", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abcd"), false);
  });
});

describe("the HTTP surface", () => {
  it("marks the session cookie HttpOnly, SameSite=Strict and leaves CSRF readable", async () =>
    scenario(async (harness) => {
      const response = await fetch(`${harness.base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(shipperRegistration("cookies@acme.example")),
      });
      const cookies = response.headers.getSetCookie();
      const session = cookies.find((cookie) => cookie.startsWith("fm_session="));
      const csrf = cookies.find((cookie) => cookie.startsWith("fm_csrf="));
      assert.match(session as string, /HttpOnly/);
      assert.match(session as string, /SameSite=Strict/);
      assert.ok(!/HttpOnly/.test(csrf as string), "the page must be able to echo the CSRF token");
    }));

  it("rejects a state-changing request without the CSRF header", async () =>
    scenario(async (harness) => {
      const client = harness.client();
      await client.post("/api/auth/register", shipperRegistration("csrf@acme.example"));
      const blocked = await client.postWithoutCsrf("/api/shipments", shipmentPayload());
      assert.equal(blocked.status, 403);
      assert.match(blocked.json.error, /CSRF/);
    }));

  it("refuses everything private without a session", async () =>
    scenario(async (harness) => {
      const anonymous = harness.client();
      for (const path of ["/api/me", "/api/shipments", "/api/opportunities", "/api/admin/stats"]) {
        assert.equal((await anonymous.get(path)).status, 401, path);
      }
    }));

  it("ends the session on sign out", async () =>
    scenario(async (harness) => {
      const client = harness.client();
      await client.post("/api/auth/register", shipperRegistration("bye@acme.example"));
      assert.equal((await client.get("/api/me")).status, 200);
      assert.equal((await client.post("/api/auth/logout")).status, 201);
      assert.equal((await client.get("/api/me")).status, 401);
    }));

  it("keeps one shipper out of another's shipment", async () =>
    scenario(async (harness) => {
      const first = harness.client();
      await first.post("/api/auth/register", shipperRegistration("first@acme.example"));
      const posted = await first.post("/api/shipments", shipmentPayload());

      const second = harness.client();
      await second.post("/api/auth/register", shipperRegistration("second@acme.example"));
      const peek = await second.get(`/api/shipments/${posted.json.id}`);
      assert.equal(peek.status, 403);
      assert.equal((await second.get("/api/shipments")).json.length, 0);
    }));

  it("keeps a shipper out of supplier-only endpoints and the reverse", async () =>
    scenario(async (harness) => {
      const shipper = harness.client();
      await shipper.post("/api/auth/register", shipperRegistration("role@acme.example"));
      assert.equal((await shipper.get("/api/opportunities")).status, 403);

      const supplier = harness.client();
      await supplier.post("/api/auth/register", supplierRegistration("role@lines.example"));
      const attempt = await supplier.post("/api/shipments", shipmentPayload());
      assert.equal(attempt.status, 403);
    }));

  it("answers 404 for unknown routes and 405 for the wrong method", async () =>
    scenario(async (harness) => {
      const client = harness.client();
      assert.equal((await client.get("/api/nope")).status, 404);
      assert.equal((await client.get("/api/auth/login")).status, 405);
    }));

  it("reports field-level errors with a 422", async () =>
    scenario(async (harness) => {
      const client = harness.client();
      await client.post("/api/auth/register", shipperRegistration("fields@acme.example"));
      const bad = await client.post(
        "/api/shipments",
        shipmentPayload({ weightLbs: 0, pickupTo: "2020-01-01" }),
      );
      assert.equal(bad.status, 422);
      assert.ok(bad.json.fields.weightLbs);
      assert.ok(bad.json.fields.pickupTo);
    }));

  it("refuses to register the same email twice", async () =>
    scenario(async (harness) => {
      const client = harness.client();
      await client.post("/api/auth/register", shipperRegistration("dup@acme.example"));
      const again = await harness
        .client()
        .post("/api/auth/register", shipperRegistration("dup@acme.example"));
      assert.equal(again.status, 409);
    }));

  it("sends security headers and does not serve files above the web root", async () =>
    scenario(async (harness) => {
      const page = await fetch(`${harness.base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      assert.equal(page.headers.get("x-content-type-options"), "nosniff");

      const traversal = await fetch(`${harness.base}/../package.json`, { redirect: "manual" });
      assert.ok(traversal.status === 400 || traversal.status === 200);
      if (traversal.status === 200) {
        const body = await traversal.text();
        assert.ok(
          !body.includes('"name": "freight-marketplace"'),
          "must not serve the package manifest",
        );
      }
    }));

  it("rejects a body that is not JSON", async () =>
    scenario(async (harness) => {
      const response = await fetch(`${harness.base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json at all",
      });
      assert.equal(response.status, 400);
    }));
});
