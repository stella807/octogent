import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appraise } from "../src/appraise.mjs";

const profile = (over = {}) => ({
  name: "Test Co",
  industry: "home-services",
  financials: { netProfit: 120_000, ownerSalary: 95_000, depreciation: 25_000, ...over.financials },
  risk: {
    ownerInDelivery: true,
    ownerHoldsKeyRelationships: true,
    secondInCommand: false,
    ownerHoursPerWeek: 60,
    topCustomerSharePct: 0.3,
    recurringRevenuePct: 0.05,
    financialsQuality: "tax-returns-only",
    documentedProcesses: "none",
    staffTenureYears: 4,
    ownerHeldLicenses: true,
    leaseTransferable: true,
    customerContracts: false,
    ...over.risk,
  },
});

describe("appraise", () => {
  it("values the business at SDE times the risk-adjusted multiple", () => {
    const result = appraise(profile());
    assert.equal(result.sde, 240_000);
    assert.equal(result.value.mid, Math.round(result.sde * result.multiple));
  });

  it("never lets risk push the multiple below the floor", () => {
    const result = appraise(
      profile({
        risk: { topCustomerSharePct: 0.8, recurringRevenuePct: 0, staffTenureYears: 0 },
      }),
    );
    assert.ok(result.multiple >= 1.0);
  });

  it("prices each open gap in dollars", () => {
    const result = appraise(profile());
    const docs = result.gaps.find((gap) => gap.id === "process-documentation");
    assert.ok(docs.value > 0);
    assert.equal(docs.value, Math.round(result.sde * docs.upside));
  });

  it("excludes factors already at target from the gap list", () => {
    const result = appraise(profile({ risk: { documentedProcesses: "documented" } }));
    assert.equal(
      result.gaps.find((gap) => gap.id === "process-documentation"),
      undefined,
    );
  });

  it("ranks gaps by value earned per month of effort, not by raw value", () => {
    const result = appraise(profile());
    const rates = result.gaps.map((gap) => gap.valuePerMonth);
    const sorted = [...rates].sort((a, b) => b - a);
    assert.deepEqual(rates, sorted);
  });

  it("reports the combined effect of fixing everything, not the sum of the parts", () => {
    const result = appraise(profile());
    const naiveSum = result.gaps.reduce((sum, gap) => sum + gap.value, 0);
    assert.ok(result.combined.value > 0);
    assert.notEqual(result.combined.value, naiveSum);
    assert.equal(result.combined.naiveSum, naiveSum);
  });

  it("says plainly when the parts do not add up to the whole", () => {
    const result = appraise(profile());
    assert.equal(typeof result.combined.overstated, "boolean");
  });

  it("marks a business with commingled cash books as not listable at any multiple", () => {
    const result = appraise(profile({ risk: { financialsQuality: "cash-and-commingled" } }));
    assert.equal(result.verdict.listable, false);
    assert.equal(result.verdict.blockers[0].id, "provability");
  });

  it("marks a loss-making business as not listable and does not print a value", () => {
    const result = appraise(profile({ financials: { netProfit: -200_000, ownerSalary: 40_000 } }));
    assert.equal(result.verdict.listable, false);
    assert.equal(result.value.mid, null);
  });

  it("considers a clean business listable", () => {
    const result = appraise(
      profile({
        risk: {
          ownerInDelivery: false,
          ownerHoldsKeyRelationships: false,
          secondInCommand: true,
          ownerHoursPerWeek: 25,
          topCustomerSharePct: 0.05,
          recurringRevenuePct: 0.5,
          financialsQuality: "reviewed-statements",
          documentedProcesses: "documented",
          staffTenureYears: 8,
          ownerHeldLicenses: false,
          customerContracts: true,
        },
      }),
    );
    assert.equal(result.verdict.listable, true);
    assert.equal(result.gaps.length, 0);
  });

  it("gives a value range, not a false point estimate", () => {
    const result = appraise(profile());
    assert.ok(result.value.low < result.value.mid);
    assert.ok(result.value.high > result.value.mid);
  });
});
