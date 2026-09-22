/**
 * Plimsoll — 24-month operating model.
 *
 * Deliberately a plain function over a plain assumptions object rather than a spreadsheet:
 * the point of the model is that every number can be traced to a stated assumption and
 * re-run when one changes. Edit `assumptions.json`, re-run, argue with the output.
 *
 * Shape of the business it encodes: a free local report is the top of the funnel, fixed-price
 * audits are the near-term cash that funds development, and subscriptions are the compounding
 * line that eventually carries the business.
 */

const round = (value) => Math.round(value);

/**
 * @param {object} assumptions see assumptions.json
 * @returns {{months: Array<object>, summary: object}}
 */
export function project(assumptions) {
  const { funnel, pricing, delivery, retention, costs } = assumptions;
  const blendedArpu =
    pricing.teamPlanMonthly * (1 - pricing.growthPlanMix) +
    pricing.growthPlanMonthly * pricing.growthPlanMix;

  const months = [];
  let subscribers = 0;
  let cash = -(costs.formationOneOff ?? 0);
  let reportRuns = funnel.reportRunsMonth1;

  for (let index = 0; index < assumptions.months; index += 1) {
    const monthNumber = index + 1;

    const capacity =
      monthNumber >= delivery.contractorStartMonth
        ? delivery.auditCapacityWithContractor
        : delivery.auditCapacityPerMonth;
    const audits = Math.min(capacity, Math.floor(reportRuns * funnel.reportToAuditRate));
    const auditRevenue = audits * pricing.auditPrice;

    // Subscriptions cannot be sold until the hosted product exists. Modelling revenue before
    // then would hide the very gap the services line is there to cover.
    const productLive = monthNumber > delivery.productBuildMonths;
    const churned = subscribers * retention.monthlyLogoChurn;
    const won = productLive
      ? reportRuns * funnel.reportToTrialRate * funnel.trialToPaidRate +
        audits * funnel.auditToSubscriptionRate
      : 0;
    subscribers = Math.max(0, subscribers - churned + won);

    const mrr = subscribers * blendedArpu;
    const revenue = mrr + auditRevenue;

    const contractorCost =
      monthNumber >= delivery.contractorStartMonth ? costs.contractorMonthly : 0;
    // The founder draws nothing while bootstrapping. Leaving it out entirely would be the
    // more flattering choice and the wrong one: unpaid founder time is a real cost being
    // deferred, and the plan should show the month it starts being paid.
    const founderDraw =
      monthNumber >= (costs.founderDrawStartMonth ?? Number.POSITIVE_INFINITY)
        ? (costs.founderDrawMonthly ?? 0)
        : 0;
    const monthCosts =
      costs.fixedMonthly +
      contractorCost +
      founderDraw +
      subscribers * costs.infraPerCustomerMonthly +
      audits * costs.auditDeliveryCost;

    const profit = revenue - monthCosts;
    cash += profit;

    months.push({
      month: monthNumber,
      reportRuns: round(reportRuns),
      audits,
      auditRevenue: round(auditRevenue),
      subscribers: round(subscribers),
      mrr: round(mrr),
      revenue: round(revenue),
      costs: round(monthCosts),
      profit: round(profit),
      cash: round(cash),
    });

    reportRuns = Math.min(funnel.reportRunsCeiling, reportRuns * (1 + funnel.reportRunsGrowthRate));
  }

  const profitable = months.find((row) => row.profit > 0);
  const last = months.at(-1);

  return {
    months,
    summary: {
      blendedArpu: round(blendedArpu),
      firstProfitableMonth: profitable ? profitable.month : null,
      lowestCash: Math.min(...months.map((row) => row.cash)),
      endingMrr: last ? last.mrr : 0,
      endingArr: last ? round(last.mrr * 12) : 0,
      endingSubscribers: last ? last.subscribers : 0,
      totalAuditRevenue: round(months.reduce((sum, row) => sum + row.auditRevenue, 0)),
      totalRevenue: round(months.reduce((sum, row) => sum + row.revenue, 0)),
      endingCash: last ? last.cash : 0,
    },
  };
}

export function renderTable({ months, summary }) {
  const money = (value) => `$${value.toLocaleString("en-US")}`;
  const header = ["Mo", "runs", "audits", "subs", "MRR", "revenue", "costs", "profit", "cash"];
  const widths = [4, 7, 8, 7, 10, 10, 10, 11, 12];
  const line = (cells) => cells.map((cell, index) => String(cell).padStart(widths[index])).join("");

  const rows = months.map((row) =>
    line([
      row.month,
      row.reportRuns,
      row.audits,
      row.subscribers,
      money(row.mrr),
      money(row.revenue),
      money(row.costs),
      money(row.profit),
      money(row.cash),
    ]),
  );

  return [
    line(header),
    "-".repeat(widths.reduce((sum, width) => sum + width, 0)),
    ...rows,
    "",
    `  blended ARPU            ${money(summary.blendedArpu)}/mo`,
    `  first profitable month  ${summary.firstProfitableMonth ?? "never"}`,
    `  deepest cash trough     ${money(summary.lowestCash)}`,
    `  month 24 MRR / ARR      ${money(summary.endingMrr)} / ${money(summary.endingArr)}`,
    `  services revenue total  ${money(summary.totalAuditRevenue)}`,
    `  total revenue (24mo)    ${money(summary.totalRevenue)}`,
    "",
  ].join("\n");
}
