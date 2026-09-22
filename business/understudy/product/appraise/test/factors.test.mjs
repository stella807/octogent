import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FACTORS, aggregateDelta, assessFactors, baseMultiple } from "../src/factors.mjs";

/** A business with none of the risks buyers price down. */
const clean = {
  ownerInDelivery: false,
  ownerHoldsKeyRelationships: false,
  secondInCommand: true,
  ownerHoursPerWeek: 30,
  topCustomerSharePct: 0.08,
  recurringRevenuePct: 0.4,
  financialsQuality: "reviewed-statements",
  documentedProcesses: "documented",
  staffTenureYears: 7,
  ownerHeldLicenses: false,
  leaseTransferable: true,
  customerContracts: true,
};

const find = (assessed, id) => assessed.find((factor) => factor.id === id);

describe("baseMultiple", () => {
  it("scales with earnings, because bigger businesses carry less key-person risk", () => {
    assert.ok(baseMultiple(80_000, "other") < baseMultiple(300_000, "other"));
    assert.ok(baseMultiple(300_000, "other") < baseMultiple(800_000, "other"));
  });

  it("lands near the 2026 market average for a mid-sized main street business", () => {
    const multiple = baseMultiple(300_000, "other");
    assert.ok(multiple >= 2.5 && multiple <= 3.5, `expected 2.5-3.5, got ${multiple}`);
  });

  it("adjusts for industry", () => {
    assert.ok(baseMultiple(300_000, "home-services") > baseMultiple(300_000, "restaurant"));
  });

  it("treats an unknown industry as neutral rather than guessing", () => {
    assert.equal(baseMultiple(300_000, "llama-grooming"), baseMultiple(300_000, "other"));
  });
});

describe("assessFactors", () => {
  it("returns an assessment for every defined factor", () => {
    assert.equal(assessFactors(clean).length, FACTORS.length);
  });

  it("gives a clean business a net positive adjustment", () => {
    const total = assessFactors(clean).reduce((sum, factor) => sum + factor.delta, 0);
    assert.ok(total > 0, `expected positive, got ${total}`);
  });

  it("penalises an owner who is the business", () => {
    const assessed = assessFactors({
      ...clean,
      ownerInDelivery: true,
      ownerHoldsKeyRelationships: true,
      secondInCommand: false,
      ownerHoursPerWeek: 65,
    });
    assert.ok(find(assessed, "owner-dependence").delta <= -1);
  });

  it("treats commingled cash books as disqualifying, not merely discounted", () => {
    const assessed = assessFactors({ ...clean, financialsQuality: "cash-and-commingled" });
    const provability = find(assessed, "provability");
    assert.ok(provability.delta <= -1.4);
    assert.equal(provability.blocking, true);
  });

  it("does not mark clean books as blocking", () => {
    assert.equal(find(assessFactors(clean), "provability").blocking, false);
  });

  it("prices customer concentration in proportion to how concentrated it is", () => {
    const mild = find(
      assessFactors({ ...clean, topCustomerSharePct: 0.2 }),
      "customer-concentration",
    );
    const severe = find(
      assessFactors({ ...clean, topCustomerSharePct: 0.5 }),
      "customer-concentration",
    );
    assert.ok(severe.delta < mild.delta);
  });

  it("rewards recurring revenue", () => {
    const none = find(assessFactors({ ...clean, recurringRevenuePct: 0 }), "recurring-revenue");
    const lots = find(assessFactors({ ...clean, recurringRevenuePct: 0.6 }), "recurring-revenue");
    assert.ok(lots.delta > none.delta);
  });

  it("reports undocumented processes as the cheapest gap to close", () => {
    const assessed = assessFactors({ ...clean, documentedProcesses: "none" });
    const docs = find(assessed, "process-documentation");
    assert.equal(docs.difficulty, "low");
    assert.ok(docs.delta < 0);
  });

  it("states a target and an effort for every factor so the report is actionable", () => {
    for (const factor of assessFactors({ ...clean, documentedProcesses: "none" })) {
      assert.ok(factor.target.length > 0, `${factor.id} has no target`);
      assert.ok(factor.effortMonths > 0, `${factor.id} has no effort`);
    }
  });

  it("scores a factor already at target as having no remaining upside", () => {
    const docs = find(assessFactors(clean), "process-documentation");
    assert.equal(docs.delta, docs.targetDelta);
  });

  it("penalises licences held personally by the owner", () => {
    const withLicence = find(
      assessFactors({ ...clean, ownerHeldLicenses: true }),
      "transferability",
    );
    const without = find(assessFactors(clean), "transferability");
    assert.ok(withLicence.delta < without.delta);
  });

  it("handles a profile with fields missing without throwing", () => {
    const assessed = assessFactors({});
    assert.equal(assessed.length, FACTORS.length);
    assert.ok(assessed.every((factor) => Number.isFinite(factor.delta)));
  });
});

describe("aggregateDelta", () => {
  it("never discounts more than the modelled maximum, however many risks pile up", () => {
    const piled = Array.from({ length: 12 }, () => -1);
    assert.ok(aggregateDelta(piled) > -1.81);
  });

  it("stays monotonic, so improving any factor always improves the result", () => {
    const before = aggregateDelta([-0.5, -0.5, -0.5]);
    const after = aggregateDelta([-0.5, -0.5, 0.25]);
    assert.ok(after > before);
  });

  it("shows diminishing returns rather than treating risks as independent", () => {
    const first = aggregateDelta([-0.5]) - aggregateDelta([]);
    const second = aggregateDelta([-0.5, -0.5]) - aggregateDelta([-0.5]);
    assert.ok(Math.abs(second) < Math.abs(first));
  });

  it("caps the premium so a flawless business is not valued as a large company", () => {
    assert.ok(aggregateDelta([1, 1, 1, 1]) <= 0.9);
  });

  it("is neutral on an empty set of factors", () => {
    assert.equal(aggregateDelta([]), 0);
  });
});
