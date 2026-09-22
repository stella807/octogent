/**
 * Understudy — 24-month operating model.
 *
 * The shape that matters here is not software economics. Delivery is done by people, so the
 * binding constraint is the coaching bench, and the Handover Program is a fixed twelve-month
 * engagement rather than an open-ended subscription. Clients graduate; they do not churn.
 * That makes the revenue line a rolling book of cohorts, which behaves quite differently
 * from recurring revenue and is the main thing this model exists to make visible.
 */

const round = (value) => Math.round(value);

/**
 * @param {object} assumptions see assumptions.json
 * @returns {{months: Array<object>, summary: object}}
 */
export function project(assumptions) {
  const { channel, pricing, capacity, costs } = assumptions;

  const months = [];
  /** Starts per month, kept so cohorts can graduate on schedule. */
  const startsByMonth = [];

  let partners = channel.partnersMonth1;
  let inbound = channel.inboundScorecardsMonth1;
  let coaches = 1;
  let cash = -(costs.formationOneOff ?? 0);
  // Demand arrives in fractions of a client. Flooring each month independently would
  // discard most of it and show a business that never starts an engagement at all.
  let programPipeline = 0;
  let transferPipeline = 0;

  for (let index = 0; index < assumptions.months; index += 1) {
    const monthNumber = index + 1;

    const referred = partners * channel.referralsPerPartnerPerMonth;
    const scorecards = inbound + referred;
    const partnerShare = scorecards === 0 ? 0 : referred / scorecards;

    const reportCapacity = coaches * capacity.reportsPerMonthPerCoach;
    const reports = Math.min(
      reportCapacity,
      Math.floor(scorecards * channel.scorecardToReportRate),
    );
    const reportRevenue = reports * pricing.readinessReport;

    // Cohorts that started programLengthMonths ago finish this month; everything started
    // inside that window is still running and still paying.
    const graduates = startsByMonth[index - pricing.programLengthMonths] ?? 0;
    const carried = stillRunning(startsByMonth, index, pricing.programLengthMonths);

    const programCapacity = coaches * capacity.concurrentProgramsPerCoach;
    programPipeline += reports * channel.reportToProgramRate;
    const starts = Math.max(0, Math.min(Math.floor(programPipeline), programCapacity - carried));
    programPipeline -= starts;
    startsByMonth.push(starts);

    const activePrograms = carried + starts;
    const programRevenue = activePrograms * pricing.programMonthly;

    transferPipeline += graduates * channel.programToTransferFileRate;
    const transferFiles = Math.floor(transferPipeline);
    transferPipeline -= transferFiles;
    const transferRevenue = transferFiles * pricing.transferFile;

    const revenue = reportRevenue + programRevenue + transferRevenue;

    // Partners are paid on the work they send, not on the whole book.
    const commission = revenue * partnerShare * pricing.partnerCommissionRate;

    const founderDraw =
      monthNumber >= (costs.founderDrawStartMonth ?? Number.POSITIVE_INFINITY)
        ? (costs.founderDrawMonthly ?? 0)
        : 0;
    // The founder is the first coach, so only additional coaches are paid for.
    const coachCost = (coaches - 1) * costs.coachMonthly;
    const monthCosts =
      costs.fixedMonthly +
      coachCost +
      founderDraw +
      commission +
      reports * costs.reportDeliveryCost;

    const profit = revenue - monthCosts;
    cash += profit;

    months.push({
      month: monthNumber,
      partners: round(partners),
      scorecards: round(scorecards),
      reports,
      activePrograms,
      graduates,
      transferFiles,
      coaches,
      reportRevenue: round(reportRevenue),
      programRevenue: round(programRevenue),
      transferRevenue: round(transferRevenue),
      revenue: round(revenue),
      commission: round(commission),
      costs: round(monthCosts),
      profit: round(profit),
      cash: round(cash),
    });

    // Hire only when the existing bench is genuinely full — capacity added ahead of demand
    // is the fastest way to turn a profitable services business into an unprofitable one.
    if (
      activePrograms >= programCapacity * capacity.coachHiredAtUtilisation &&
      coaches < capacity.maxCoaches
    ) {
      coaches += 1;
    }

    partners = Math.min(channel.partnerCeiling, partners + channel.partnersAddedPerMonth);
    inbound = Math.min(channel.inboundCeiling, inbound * (1 + channel.inboundGrowthRate));
  }

  const profitable = months.find((row) => row.profit > 0);
  const last = months.at(-1);

  return {
    months,
    summary: {
      firstProfitableMonth: profitable ? profitable.month : null,
      lowestCash: Math.min(...months.map((row) => row.cash)),
      endingCash: last ? last.cash : 0,
      endingRevenue: last ? last.revenue : 0,
      endingActivePrograms: last ? last.activePrograms : 0,
      endingCoaches: last ? last.coaches : 0,
      totalRevenue: round(months.reduce((sum, row) => sum + row.revenue, 0)),
      totalReports: months.reduce((sum, row) => sum + row.reports, 0),
      runRate: last ? round(last.revenue * 12) : 0,
    },
  };
}

/**
 * Programmes still running from earlier months.
 *
 * A cohort that starts in month i is active in months i, i+1 … i+length-1 and graduates in
 * month i+length, so the carried window is length-1 months wide, not length. Counting one
 * month too many inflates programme revenue by a full cohort at steady state.
 */
function stillRunning(startsByMonth, index, length) {
  let total = 0;
  for (let i = Math.max(0, index - length + 1); i < index; i += 1) total += startsByMonth[i];
  return total;
}

export function renderTable({ months, summary }) {
  const money = (value) => `$${value.toLocaleString("en-US")}`;
  const header = [
    "Mo",
    "cards",
    "rpts",
    "active",
    "grad",
    "coach",
    "revenue",
    "costs",
    "profit",
    "cash",
  ];
  const widths = [4, 7, 6, 8, 6, 7, 10, 10, 11, 12];
  const line = (cells) => cells.map((cell, index) => String(cell).padStart(widths[index])).join("");

  return [
    line(header),
    "-".repeat(widths.reduce((sum, width) => sum + width, 0)),
    ...months.map((row) =>
      line([
        row.month,
        row.scorecards,
        row.reports,
        row.activePrograms,
        row.graduates,
        row.coaches,
        money(row.revenue),
        money(row.costs),
        money(row.profit),
        money(row.cash),
      ]),
    ),
    "",
    `  first profitable month   ${summary.firstProfitableMonth ?? "never"}`,
    `  deepest cash trough      ${money(summary.lowestCash)}`,
    `  month 24 revenue         ${money(summary.endingRevenue)}  (${money(summary.runRate)} run rate)`,
    `  active programmes        ${summary.endingActivePrograms} across ${summary.endingCoaches} coaches`,
    `  reports delivered        ${summary.totalReports}`,
    `  total revenue (24mo)     ${money(summary.totalRevenue)}`,
    "",
  ].join("\n");
}
