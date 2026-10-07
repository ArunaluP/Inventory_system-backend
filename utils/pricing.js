// BOQ pricing — the server's authoritative copy. The frontend has the same rules in
// inventory-frontend/src/utils/templateData.js (calculateTotals); keep the two in sync.
//
//   line amount     = round2(qty × price)
//   items subtotal  = sum of line amounts
//
//   Additions Section 1 (non-compounding, each on the items subtotal):
//     percent mode: round2(subtotal × % / 100)   amount mode: the typed amount (% derived)
//   Total Cost      = subtotal + sum of Section 1 amounts      (negative = deduction)
//
//   Additional Section 2 (compounding, each on the running total, in row order):
//     running₀ = Total Cost
//     percent mode: amount = round2(running × % / 100)   amount mode: the typed amount (% derived)
//     running  = running + amount
//   Solution Price  = running after the last row
//   Cash Price      = same chain, but only through rows ticked "In cash price"
// A manually quoted final price replaces the calculated one when given.

// Round half away from zero to 2 / 4 decimals; EPSILON fixes cases like 1.005 → 1.01
const round2 = (value) => Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
const round4 = (value) => Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 10000) / 10000;

const lineAmount = (item) => round2((Number(item.quantity) || 0) * (Number(item.unit_price) || 0));

const sectionSubtotal = (section) => round2(section.items.reduce((sum, item) => sum + lineAmount(item), 0));

// Section 1: % and amount of each row from whichever the user typed, on the items subtotal
const resolveAdditionalCosts = (costs, subtotal) => costs.map((cost) => {
  if (cost.calc_mode === 'amount') {
    const amount = round2(Number(cost.amount) || 0);
    return { ...cost, amount, percentage: subtotal ? round4((amount / subtotal) * 100) : 0 };
  }
  const percentage = round4(Number(cost.percentage) || 0);
  return { ...cost, percentage, amount: round2((subtotal * percentage) / 100) };
});

// One compounding step: the row's amount on a given running base
const compoundStep = (row, base) => {
  if (row.calc_mode === 'amount') {
    const amount = round2(Number(row.amount) || 0);
    return { amount, percentage: base ? round4((amount / base) * 100) : 0 };
  }
  const percentage = round4(Number(row.percentage) || 0);
  return { amount: round2((base * percentage) / 100), percentage };
};

// Section 2: run the Solution chain over every row and the Cash chain over ticked rows only
const resolveSection2 = (rows, totalCost) => {
  let running = totalCost;
  let cashRunning = totalCost;
  const resolved = rows.map((row) => {
    const step = compoundStep(row, running);
    const base = running;
    running = round2(running + step.amount);

    let cashAmount = null;
    if (row.include_in_cash_price) {
      // A % row compounds on the cash chain's own running total; a fixed amount adds as typed
      cashAmount = row.calc_mode === 'amount' ? step.amount : compoundStep(row, cashRunning).amount;
      cashRunning = round2(cashRunning + cashAmount);
    }
    return { ...row, percentage: step.percentage, base_amount: base, amount: step.amount, cash_amount: cashAmount, running_total: running };
  });
  return { rows: resolved, solution: running, cash: cashRunning };
};

const calculatePricing = ({ sections, additionalCosts, section2Additions, solutionPriceOverride, cashPriceOverride }) => {
  const subtotal = round2(sections.reduce((sum, section) => sum + sectionSubtotal(section), 0));
  const costs = resolveAdditionalCosts(additionalCosts, subtotal);
  const totalCost = round2(subtotal + costs.reduce((sum, c) => sum + c.amount, 0));
  const section2 = resolveSection2(section2Additions || [], totalCost);

  return {
    subtotal,
    costs,
    totalCost,
    section2: section2.rows,
    solutionPriceCalculated: section2.solution,
    cashPriceCalculated: section2.cash,
    solutionPrice: solutionPriceOverride ?? section2.solution,
    cashPrice: cashPriceOverride ?? section2.cash
  };
};

module.exports = { round2, round4, lineAmount, sectionSubtotal, calculatePricing };
