import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { project } from "../financial-model.mjs";

const base = {
  months: 18,
  channel: {
    partnersMonth1: 0,
    partnersAddedPerMonth: 0,
    partnerCeiling: 0,
    referralsPerPartnerPerMonth: 0,
    inboundScorecardsMonth1: 100,
    inboundGrowthRate: 0,
    inboundCeiling: 100,
    scorecardToReportRate: 0.1,
    reportToProgramRate: 0,
    programToTransferFileRate: 0,
  },
  pricing: {
    readinessReport: 1000,
    programMonthly: 1000,
    programLengthMonths: 12,
    transferFile: 3000,
    partnerCommissionRate: 0,
  },
  capacity: {
    concurrentProgramsPerCoach: 10,
    reportsPerMonthPerCoach: 100,
    coachHiredAtUtilisation: 0.8,
    maxCoaches: 1,
  },
  costs: {
    fixedMonthly: 0,
    coachMonthly: 0,
    reportDeliveryCost: 0,
    founderDrawMonthly: 0,
    founderDrawStartMonth: 99,
    formationOneOff: 0,
  },
};

const clone = (over) => ({
  ...base,
  ...over,
  channel: { ...base.channel, ...over.channel },
  pricing: { ...base.pricing, ...over.pricing },
  capacity: { ...base.capacity, ...over.capacity },
  costs: { ...base.costs, ...over.costs },
});

describe("project", () => {
  it("produces one row per month", () => {
    assert.equal(project(base).months.length, 18);
  });

  it("earns report revenue from scorecard conversions", () => {
    assert.equal(project(base).months[0].reports, 10);
    assert.equal(project(base).months[0].reportRevenue, 10_000);
  });

  it("counts partner referrals alongside inbound", () => {
    const result = project(
      clone({
        channel: { partnersMonth1: 10, referralsPerPartnerPerMonth: 1, partnerCeiling: 10 },
      }),
    );
    assert.equal(result.months[0].scorecards, 110);
  });

  it("caps reports at what the coaching bench can deliver", () => {
    const result = project(clone({ capacity: { reportsPerMonthPerCoach: 4 } }));
    assert.equal(result.months[0].reports, 4);
  });

  it("graduates a programme after its fixed term instead of churning it forever", () => {
    const result = project(
      clone({
        channel: { reportToProgramRate: 1 },
        pricing: { programLengthMonths: 3 },
        capacity: { concurrentProgramsPerCoach: 100 },
      }),
    );
    // 10 start each month, each runs 3 months, so the active book levels off at 30.
    assert.equal(result.months[0].activePrograms, 10);
    assert.equal(result.months[2].activePrograms, 30);
    assert.equal(result.months[5].activePrograms, 30);
  });

  it("earns a transfer file from a share of graduates", () => {
    const result = project(
      clone({
        channel: { reportToProgramRate: 1, programToTransferFileRate: 0.5 },
        pricing: { programLengthMonths: 3 },
        capacity: { concurrentProgramsPerCoach: 100 },
      }),
    );
    assert.equal(result.months[2].graduates, 0);
    assert.equal(result.months[3].graduates, 10);
    assert.equal(result.months[3].transferFiles, 5);
  });

  it("will not take on more concurrent programmes than the bench can hold", () => {
    const result = project(
      clone({
        channel: { reportToProgramRate: 1 },
        capacity: { concurrentProgramsPerCoach: 15, maxCoaches: 1 },
      }),
    );
    assert.ok(result.months.every((row) => row.activePrograms <= 15));
  });

  it("hires a coach once the bench passes the utilisation trigger", () => {
    const result = project(
      clone({
        channel: { reportToProgramRate: 1 },
        capacity: { concurrentProgramsPerCoach: 10, maxCoaches: 3 },
      }),
    );
    assert.equal(result.months[0].coaches, 1);
    assert.ok(result.months.at(-1).coaches > 1);
  });

  it("carries fractional demand forward instead of flooring it away each month", () => {
    // Three reports a month at a 30% take is 0.9 programmes — flooring that to zero every
    // month would show a business that never starts a single engagement.
    const result = project(
      clone({
        channel: {
          inboundScorecardsMonth1: 30,
          scorecardToReportRate: 0.1,
          reportToProgramRate: 0.3,
        },
        capacity: { concurrentProgramsPerCoach: 100 },
      }),
    );
    assert.ok(result.months.slice(0, 4).some((row) => row.activePrograms > 0));
  });

  it("pays referral commission only on partner-sourced work", () => {
    const result = project(
      clone({
        channel: { partnersMonth1: 10, referralsPerPartnerPerMonth: 1, partnerCeiling: 10 },
        pricing: { partnerCommissionRate: 0.2 },
      }),
    );
    assert.ok(result.months[0].commission > 0);
  });

  it("charges no commission when there are no partners", () => {
    assert.equal(
      project(clone({ pricing: { partnerCommissionRate: 0.2 } })).months[0].commission,
      0,
    );
  });

  it("tracks cash as a running balance and reports the first profitable month", () => {
    const result = project(clone({ costs: { fixedMonthly: 2_000 } }));
    assert.equal(result.months[0].cash, 10_000 - 2_000);
    assert.equal(result.summary.firstProfitableMonth, 1);
  });

  it("reports no profitable month when costs always exceed revenue", () => {
    const result = project(clone({ costs: { fixedMonthly: 50_000 } }));
    assert.equal(result.summary.firstProfitableMonth, null);
    assert.ok(result.summary.lowestCash < 0);
  });
});
