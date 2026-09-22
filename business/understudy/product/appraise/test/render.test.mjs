import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appraise } from "../src/appraise.mjs";
import { renderReport } from "../src/render.mjs";

const base = {
  name: "Test Co",
  industry: "home-services",
  financials: { netProfit: 120_000, ownerSalary: 95_000 },
  risk: { documentedProcesses: "none", financialsQuality: "tax-returns-only" },
};

describe("renderReport", () => {
  it("shows a price range and a priced gap list for a listable business", () => {
    const output = renderReport(appraise(base));
    assert.match(output, /WHAT IT WOULD FETCH TODAY/);
    assert.match(output, /WHAT EACH GAP IS WORTH/);
    assert.match(output, /Documented operations/);
  });

  it("withholds a price entirely when the business is not listable", () => {
    const output = renderReport(
      appraise({ ...base, risk: { ...base.risk, financialsQuality: "cash-and-commingled" } }),
    );
    assert.match(output, /NOT LISTABLE/);
    assert.doesNotMatch(output, /WHAT IT WOULD FETCH TODAY/);
  });

  it("spells add-backs out in words rather than field names", () => {
    const output = renderReport(appraise(base));
    assert.match(output, /Owner's salary/);
    assert.doesNotMatch(output, /ownerSalary/);
  });

  it("always states that this is not a certified valuation", () => {
    assert.match(renderReport(appraise(base)), /not a certified valuation/);
  });
});
