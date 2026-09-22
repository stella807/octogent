import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSde } from "../src/sde.mjs";

describe("normalizeSde", () => {
  it("adds the owner's pay and benefits back to net profit", () => {
    const result = normalizeSde({ netProfit: 100_000, ownerSalary: 90_000, ownerBenefits: 15_000 });
    assert.equal(result.sde, 205_000);
  });

  it("adds back interest, depreciation and one-time costs", () => {
    const result = normalizeSde({
      netProfit: 50_000,
      interest: 9_000,
      depreciation: 31_000,
      oneTimeExpenses: 12_000,
    });
    assert.equal(result.sde, 102_000);
  });

  it("itemises every add-back so a buyer can challenge each one", () => {
    const result = normalizeSde({
      netProfit: 10_000,
      ownerSalary: 80_000,
      discretionaryExpenses: 5_000,
    });
    const labels = result.addBacks.map((entry) => entry.key);
    assert.deepEqual(labels, ["ownerSalary", "discretionaryExpenses"]);
    assert.equal(result.addBacks[0].amount, 80_000);
  });

  it("treats missing lines as zero rather than throwing", () => {
    assert.equal(normalizeSde({ netProfit: 42_000 }).sde, 42_000);
  });

  it("flags add-backs that exceed net profit, which is what draws diligence scrutiny", () => {
    const result = normalizeSde({
      netProfit: 20_000,
      ownerSalary: 80_000,
      discretionaryExpenses: 40_000,
    });
    assert.equal(result.addBackHeavy, true);
  });

  it("does not flag a business whose profit stands on its own", () => {
    const result = normalizeSde({ netProfit: 300_000, ownerSalary: 90_000 });
    assert.equal(result.addBackHeavy, false);
  });

  it("refuses to report a negative SDE as a valuation basis", () => {
    const result = normalizeSde({ netProfit: -80_000, ownerSalary: 20_000 });
    assert.equal(result.sde, -60_000);
    assert.equal(result.viable, false);
  });
});
