/** Terminal rendering for an appraisal. Presentation only — no valuation logic here. */

const money = (value) => (value === null ? "—" : `$${Math.round(value).toLocaleString("en-US")}`);

const DIFFICULTY_MARK = { low: "●○○", medium: "●●○", high: "●●●" };

/** Add-back keys are accounting shorthand; an owner reads the report, so spell them out. */
const ADD_BACK_LABEL = {
  ownerSalary: "Owner's salary",
  ownerBenefits: "Owner's benefits",
  discretionaryExpenses: "Discretionary spending",
  oneTimeExpenses: "One-time costs",
  interest: "Interest",
  depreciation: "Depreciation",
  amortization: "Amortisation",
  incomeTax: "Income tax",
};

const LABEL_WIDTH = 36;
const AMOUNT_WIDTH = 13;
const RULE = "─".repeat(72);

const row = (label, amount) =>
  `  ${label.padEnd(LABEL_WIDTH)}${money(amount).padStart(AMOUNT_WIDTH)}`;

function renderEarnings(result) {
  const lines = ["  EARNINGS", row("Net profit", result.earnings.netProfit)];
  for (const entry of result.earnings.addBacks) {
    lines.push(row(`  + ${ADD_BACK_LABEL[entry.key] ?? entry.key}`, entry.amount));
  }
  lines.push(`  ${"─".repeat(LABEL_WIDTH + AMOUNT_WIDTH)}`);
  lines.push(row("Seller's discretionary earnings", result.sde));
  if (result.verdict.addBackHeavy) {
    lines.push("");
    lines.push("  ! Add-backs exceed net profit. Every line will be challenged in diligence,");
    lines.push("    and anything you cannot document will simply be struck out.");
  }
  return lines;
}

function renderNotListable(result) {
  const lines = ["  VERDICT    NOT LISTABLE AS IT STANDS", ""];
  for (const blocker of result.verdict.blockers) {
    lines.push(`    · ${blocker.label} — this ends a sale before price is ever discussed`);
  }
  if (result.sde <= 0) {
    lines.push("    · The business does not currently earn a living for one owner-operator");
  }
  lines.push("");
  lines.push("  No asking price is shown, because there is not an honest one to show.");
  lines.push("  Clear the blocker above and run this again.");
  return lines;
}

function renderGaps(result) {
  const header =
    `  ${"WHAT EACH GAP IS WORTH".padEnd(30)}${"value".padStart(10)}` +
    `${"months".padStart(8)}${"effort".padStart(8)}${"per month".padStart(12)}`;
  const lines = [header, `  ${RULE}`];

  for (const gap of result.gaps) {
    lines.push(
      `  ${gap.label.padEnd(30)}${money(gap.value).padStart(10)}` +
        `${String(gap.effortMonths).padStart(8)}${DIFFICULTY_MARK[gap.difficulty].padStart(8)}` +
        `${money(gap.valuePerMonth).padStart(12)}`,
    );
    lines.push(`      ${gap.target}`);
  }
  return lines;
}

function renderCombined(result) {
  const after = result.value.mid + result.combined.value;
  const lines = [
    "  IF YOU CLOSED ALL OF THEM",
    `    ${money(result.value.mid)}  →  ${money(after)}    ` +
      `(+${money(result.combined.value)}, ${result.combined.multiple}× SDE)`,
    `    Roughly ${result.combined.effortMonths} months of work.`,
    "",
  ];

  lines.push(
    `    Listed one by one the gaps come to ${money(result.combined.naiveSum)}. Together they are`,
  );
  lines.push(
    result.combined.overstated
      ? `    worth ${money(result.combined.value)} — they overlap, and fixing one partly fixes another.`
      : `    worth ${money(result.combined.value)} — they compound. A buyer re-rates a business that`,
  );
  if (!result.combined.overstated) {
    lines.push("    clears several risks at once, rather than crediting each one separately.");
  }
  return lines;
}

export function renderReport(result) {
  const lines = [
    "",
    `  UNDERSTUDY   ${result.name}`,
    `  ${result.industry} · sellability appraisal`,
    `  ${RULE}`,
    "",
    ...renderEarnings(result),
    "",
  ];

  if (!result.verdict.listable) {
    lines.push(...renderNotListable(result), "");
    return `${lines.join("\n")}\n`;
  }

  lines.push("  WHAT IT WOULD FETCH TODAY");
  lines.push(`    ${money(result.value.low)} – ${money(result.value.high)}`);
  lines.push(
    `    midpoint ${money(result.value.mid)} at ${result.multiple}× SDE ` +
      `(${result.base}× base for this size and trade, risk-adjusted down)`,
  );
  lines.push("");

  if (result.gaps.length === 0) {
    lines.push("  No open gaps. This business is ready to go to market.", "");
    return `${lines.join("\n")}\n`;
  }

  lines.push(...renderGaps(result), "");
  lines.push(...renderCombined(result), "");
  lines.push("  An estimate of a likely sale range, not a certified valuation.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
