import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { project } from "../financial-model.mjs";

const base = {
  months: 6,
  funnel: {
    reportRunsMonth1: 100,
    reportRunsGrowthRate: 0,
    reportRunsCeiling: 100,
    reportToAuditRate: 0,
    reportToTrialRate: 0,
    trialToPaidRate: 0,
    auditToSubscriptionRate: 0,
  },
  pricing: { auditPrice: 7500, teamPlanMonthly: 500, growthPlanMonthly: 1500, growthPlanMix: 0 },
  delivery: {
    auditCapacityPerMonth: 2,
    auditCapacityWithContractor: 4,
    contractorStartMonth: 99,
    productBuildMonths: 0,
  },
  retention: { monthlyLogoChurn: 0 },
  costs: {
    fixedMonthly: 0,
    contractorMonthly: 0,
    infraPerCustomerMonthly: 0,
    auditDeliveryCost: 0,
    formationOneOff: 0,
    founderDrawMonthly: 0,
    founderDrawStartMonth: 99,
  },
};

const clone = (over) => ({
  ...base,
  ...over,
  funnel: { ...base.funnel, ...over.funnel },
  delivery: { ...base.delivery, ...over.delivery },
  costs: { ...base.costs, ...over.costs },
  retention: { ...base.retention, ...over.retention },
  pricing: { ...base.pricing, ...over.pricing },
});

describe("project", () => {
  it("produces one row per month", () => {
    assert.equal(project(base).months.length, 6);
  });

  it("caps audits at delivery capacity no matter how big the funnel is", () => {
    const result = project(clone({ funnel: { reportToAuditRate: 1 } }));
    assert.equal(result.months[0].audits, 2);
  });

  it("raises capacity once a contractor is hired", () => {
    const result = project(
      clone({
        funnel: { reportToAuditRate: 1 },
        delivery: { contractorStartMonth: 3 },
      }),
    );
    assert.equal(result.months[1].audits, 2);
    assert.equal(result.months[2].audits, 4);
  });

  it("recognises audit revenue in the month it is delivered", () => {
    const result = project(clone({ funnel: { reportToAuditRate: 1 } }));
    assert.equal(result.months[0].auditRevenue, 15000);
  });

  it("does not sell subscriptions before the product is built", () => {
    const result = project(
      clone({
        funnel: { reportToTrialRate: 1, trialToPaidRate: 1 },
        delivery: { productBuildMonths: 3 },
      }),
    );
    assert.equal(result.months[0].mrr, 0);
    assert.equal(result.months[2].mrr, 0);
    assert.ok(result.months[3].mrr > 0);
  });

  it("compounds subscribers across months and applies churn", () => {
    const result = project(
      clone({
        funnel: { reportToTrialRate: 0.1, trialToPaidRate: 1 },
        retention: { monthlyLogoChurn: 0.5 },
      }),
    );
    // 10 land in month 1. Month 2: half of them churn, 10 more land.
    assert.equal(result.months[0].subscribers, 10);
    assert.equal(result.months[1].subscribers, 15);
  });

  it("blends plan pricing by the growth-plan mix", () => {
    const result = project(
      clone({
        funnel: { reportToTrialRate: 0.1, trialToPaidRate: 1 },
        pricing: { growthPlanMix: 0.5 },
      }),
    );
    assert.equal(result.months[0].mrr, 10 * 1000);
  });

  it("tracks cash as a running balance of revenue less costs", () => {
    const result = project(
      clone({ funnel: { reportToAuditRate: 1 }, costs: { fixedMonthly: 1000 } }),
    );
    assert.equal(result.months[0].cash, 15000 - 1000);
    assert.equal(result.months[1].cash, 2 * (15000 - 1000));
  });

  it("reports the first month the business turns cash-flow positive", () => {
    const result = project(clone({ funnel: { reportToAuditRate: 1 } }));
    assert.equal(result.summary.firstProfitableMonth, 1);
  });

  it("starts charging the founder draw only from its start month", () => {
    const result = project(
      clone({ costs: { founderDrawMonthly: 1000, founderDrawStartMonth: 3 } }),
    );
    assert.equal(result.months[1].costs, 0);
    assert.equal(result.months[2].costs, 1000);
  });

  it("reports no profitable month when costs always exceed revenue", () => {
    const result = project(clone({ costs: { fixedMonthly: 5000 } }));
    assert.equal(result.summary.firstProfitableMonth, null);
    assert.ok(result.summary.lowestCash < 0);
  });
});
