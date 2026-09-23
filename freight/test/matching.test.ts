import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { eligibilityFailures, rankSuppliers, scoreSupplier } from "../src/domain/matching.ts";
import { matchInput, testShipment } from "./helpers.ts";

describe("eligibility", () => {
  it("passes a supplier that covers the lane with the right equipment", () => {
    assert.deepEqual(eligibilityFailures(testShipment(), matchInput()), []);
  });

  it("excludes a supplier without the required trailer", () => {
    const failures = eligibilityFailures(testShipment({ equipment: "flatbed" }), matchInput());
    assert.deepEqual(failures, ["No flatbed in fleet"]);
  });

  it("excludes a supplier whose fleet cannot legally carry the cargo", () => {
    const failures = eligibilityFailures(
      testShipment({ cargoType: "frozen_food", equipment: "dry_van" }),
      matchInput({ profile: { equipment: ["dry_van"] } }),
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0] as string, /frozen food needs one of: reefer/);
  });

  it("excludes a load over the stated weight limit", () => {
    const failures = eligibilityFailures(
      testShipment({ weightLbs: 48_000 }),
      matchInput({ profile: { maxWeightLbs: 44_000 } }),
    );
    assert.match(failures[0] as string, /over the 44,000 lb stated maximum/);
  });

  it("excludes a supplier missing a required capability", () => {
    const failures = eligibilityFailures(
      testShipment({ specialRequirements: ["liftgate"] }),
      matchInput(),
    );
    assert.deepEqual(failures, ["Missing required capability: liftgate"]);
  });

  it("excludes a supplier serving neither end of the lane", () => {
    const failures = eligibilityFailures(
      testShipment(),
      matchInput({ profile: { serviceRegions: ["US-CA"] } }),
    );
    assert.deepEqual(failures, ["Serves neither US-FL nor US-PR"]);
  });

  it("excludes a company whose verification was rejected", () => {
    const failures = eligibilityFailures(
      testShipment(),
      matchInput({ company: { verificationStatus: "rejected" } }),
    );
    assert.deepEqual(failures, ["Verification rejected by platform admin"]);
  });
});

describe("scoring", () => {
  it("explains every factor it used", () => {
    const result = scoreSupplier(testShipment(), matchInput());
    assert.equal(result.eligible, true);
    assert.equal(result.factors.length, 9);
    for (const factor of result.factors) {
      assert.ok(factor.detail.length > 0, `${factor.key} must explain itself`);
      assert.ok(factor.score >= 0 && factor.score <= 1, `${factor.key} score in range`);
    }
    const weights = result.factors.reduce((sum, factor) => sum + factor.weight, 0);
    assert.ok(Math.abs(weights - 1) < 1e-9, "weights sum to 1");
  });

  it("scores a new supplier neutrally rather than badly, and says so", () => {
    const result = scoreSupplier(testShipment(), matchInput());
    const performance = result.factors.find((factor) => factor.key === "performance");
    assert.equal(performance?.neutral, true);
    assert.equal(performance?.score, 0.5);
    assert.match(performance?.detail ?? "", /not penalised/);
  });

  it("rewards a proven on-time record over an unproven one", () => {
    const proven = scoreSupplier(
      testShipment(),
      matchInput({ stats: { completedShipments: 12, onTimeDeliveries: 12, lateDeliveries: 0 } }),
    );
    const unproven = scoreSupplier(testShipment(), matchInput());
    assert.ok(proven.matchPercent > unproven.matchPercent);
  });

  it("penalises a supplier blacked out across the whole pickup window", () => {
    const result = scoreSupplier(
      testShipment(),
      matchInput({ profile: { blackoutDates: ["2026-10-05", "2026-10-06"] } }),
    );
    const availability = result.factors.find((factor) => factor.key === "availability");
    assert.equal(availability?.score, 0);
    assert.equal(result.eligible, true, "availability is a ranking signal, not a hard block");
  });

  it("treats a missing published rate as unknown, not as expensive", () => {
    const result = scoreSupplier(
      testShipment(),
      matchInput({ profile: { ratePerMileCents: null } }),
    );
    const price = result.factors.find((factor) => factor.key === "price");
    assert.equal(price?.neutral, true);
    assert.match(price?.detail ?? "", /No published rate/);
  });

  it("gives an ineligible supplier no score at all", () => {
    const result = scoreSupplier(testShipment({ equipment: "tanker" }), matchInput());
    assert.equal(result.eligible, false);
    assert.equal(result.matchPercent, 0);
    assert.deepEqual(result.exclusions, ["No tanker in fleet"]);
  });
});

describe("ranking", () => {
  it("orders eligible suppliers first and keeps the excluded ones with reasons", () => {
    const strong = matchInput({
      company: { id: "co_strong", name: "Strong Lines" },
      stats: {
        completedShipments: 20,
        onTimeDeliveries: 20,
        opportunitiesSeen: 10,
        quotesSubmitted: 9,
      },
    });
    const weak = matchInput({
      company: { id: "co_weak", name: "Weak Lines", verificationStatus: "unverified" },
      profile: { lanes: [], serviceRegions: ["US-FL"], ratePerMileCents: 600 },
    });
    const ineligible = matchInput({
      company: { id: "co_out", name: "Out Of Scope" },
      profile: { equipment: ["flatbed"], serviceRegions: ["US-FL"] },
    });

    const ranked = rankSuppliers(testShipment(), [weak, ineligible, strong]);
    assert.deepEqual(
      ranked.map((result) => result.companyId),
      ["co_strong", "co_weak", "co_out"],
    );
    assert.equal(ranked[2]?.eligible, false);
    assert.ok((ranked[2]?.exclusions.length ?? 0) > 0);
  });
});
