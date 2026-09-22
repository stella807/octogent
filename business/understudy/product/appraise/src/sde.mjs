/**
 * Seller's Discretionary Earnings.
 *
 * SDE is the basis every sub-$5M business sale is priced on: what the business earns for
 * one full-time owner-operator, before that owner's own pay and discretion. Every add-back
 * is itemised rather than summed silently, because in diligence each one is argued
 * individually and an add-back the seller cannot document is simply removed.
 */

/** Lines added back to net profit, in the order a buyer's accountant reads them. */
const ADD_BACK_KEYS = [
  "ownerSalary",
  "ownerBenefits",
  "discretionaryExpenses",
  "oneTimeExpenses",
  "interest",
  "depreciation",
  "amortization",
  "incomeTax",
];

/**
 * @param {object} financials net profit plus any of the add-back lines
 * @returns {{sde: number, addBacks: Array<{key: string, amount: number}>, addBackHeavy: boolean, viable: boolean}}
 */
export function normalizeSde(financials = {}) {
  const netProfit = financials.netProfit ?? 0;

  const addBacks = ADD_BACK_KEYS.map((key) => ({ key, amount: financials[key] ?? 0 })).filter(
    (entry) => entry.amount !== 0,
  );

  const addBackTotal = addBacks.reduce((sum, entry) => sum + entry.amount, 0);
  const sde = netProfit + addBackTotal;

  return {
    netProfit,
    addBacks,
    addBackTotal,
    sde,
    // When add-backs exceed the profit they sit on, the earnings are a construction rather
    // than a result. Buyers discount these hard and lenders often refuse them outright.
    addBackHeavy: addBackTotal > Math.max(netProfit, 0),
    viable: sde > 0,
  };
}
