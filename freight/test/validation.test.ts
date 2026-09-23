import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ValidationError,
  parseRegistrationInput,
  parseShipmentInput,
} from "../src/domain/validation.ts";
import { shipmentPayload } from "./helpers.ts";

function fieldsOf(work: () => unknown): Record<string, string> {
  try {
    work();
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("expected a ValidationError");
}

describe("shipment input", () => {
  it("accepts a complete post and converts dollars to cents", () => {
    const input = parseShipmentInput(shipmentPayload());
    assert.equal(input.targetPriceCents, 450_000);
    assert.equal(input.visibility, "marketplace");
    assert.deepEqual(input.specialRequirements, ["port_drayage"]);
  });

  it("collects every missing field at once", () => {
    const fields = fieldsOf(() => parseShipmentInput({}));
    assert.ok(Object.keys(fields).length > 8, "one field at a time is a bad form");
  });

  it("rejects a pickup window that ends before it starts", () => {
    const fields = fieldsOf(() => parseShipmentInput(shipmentPayload({ pickupTo: "2026-10-01" })));
    assert.match(fields.pickupTo as string, /ends before it starts/);
  });

  it("rejects a delivery deadline before pickup", () => {
    const fields = fieldsOf(() => parseShipmentInput(shipmentPayload({ deliverBy: "2026-10-01" })));
    assert.match(fields.deliverBy as string, /before pickup/);
  });

  it("rejects a region the marketplace does not serve", () => {
    const fields = fieldsOf(() => parseShipmentInput(shipmentPayload({ destinationRegion: "ZZ" })));
    assert.match(fields.destinationRegion as string, /do not serve/);
  });

  it("rejects unknown enum values instead of silently dropping them", () => {
    const fields = fieldsOf(() =>
      parseShipmentInput(shipmentPayload({ specialRequirements: ["liftgate", "teleportation"] })),
    );
    assert.ok(fields.specialRequirements);
  });

  it("requires at least one invitee on a private post", () => {
    const fields = fieldsOf(() =>
      parseShipmentInput(shipmentPayload({ visibility: "invited", invitedCompanyIds: [] })),
    );
    assert.match(fields.invitedCompanyIds as string, /Invite at least one supplier/);
  });

  it("drops invitees on a public post rather than storing a half-private shipment", () => {
    const input = parseShipmentInput(shipmentPayload({ invitedCompanyIds: ["co_1"] }));
    assert.deepEqual(input.invitedCompanyIds, []);
  });
});

describe("registration input", () => {
  it("normalises the email and keeps the password as typed", () => {
    const input = parseRegistrationInput({
      email: "  OPS@Acme.com ",
      password: "a-long-enough-password",
      name: "Dana",
      companyName: "Acme",
      companyKind: "shipper",
      contactPhone: "305-555-0100",
      companyCity: "Miami",
      companyRegion: "fl",
      companyCountry: "us",
    });
    assert.equal(input.email, "ops@acme.com");
    assert.equal(input.place.region, "FL");
    assert.equal(input.password, "a-long-enough-password");
  });

  it("rejects a short password", () => {
    const fields = fieldsOf(() =>
      parseRegistrationInput({
        email: "a@b.co",
        password: "short",
        name: "A",
        companyName: "B",
        companyKind: "shipper",
        contactPhone: "3055550100",
        companyCity: "Miami",
        companyRegion: "FL",
        companyCountry: "US",
      }),
    );
    assert.match(fields.password as string, /at least 12 characters/);
  });

  it("rejects a malformed email", () => {
    const fields = fieldsOf(() =>
      parseRegistrationInput({
        email: "not-an-email",
        password: "a-long-enough-password",
        name: "A",
        companyName: "B",
        companyKind: "shipper",
        contactPhone: "3055550100",
        companyCity: "Miami",
        companyRegion: "FL",
        companyCountry: "US",
      }),
    );
    assert.match(fields.email as string, /valid email/);
  });
});
