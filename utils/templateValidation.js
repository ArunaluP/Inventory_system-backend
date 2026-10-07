// Validates and normalises a template payload before anything touches the database.
// Limits mirror the column sizes (VARCHAR lengths, DECIMAL ranges) so MySQL never has to
// reject or truncate a value. Returns { data, errors }; errors is a list of readable messages.

const { parseDecimal, parseId, parseBoolean, isTextLike } = require('./parse');
const { sectionSubtotal } = require('./pricing');

const LIMITS = {
  maxSections: 100,
  maxItemsPerSection: 300,
  maxItemsTotal: 2000,
  maxAdditionalCosts: 20,
  maxSection2Rows: 10,
  maxSpecLines: 20,
  qtyOrPrice: 99999999.99,        // DECIMAL(10,2)
  lineAmount: 9999999999.99,      // DECIMAL(12,2)
  money: 999999999999.99,         // DECIMAL(14,2)
  derivedPercent: 99999999.9999   // DECIMAL(12,4)
};

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

const text = (value, { label, max, required = false }, errors) => {
  if (!isBlank(value) && !isTextLike(value)) {
    errors.push(`${label} must be text.`);
    return '';
  }
  const str = isBlank(value) ? '' : String(value).trim();
  if (required && !str) errors.push(`${label} is required.`);
  if (str.length > max) errors.push(`${label} must be at most ${max} characters (has ${str.length}).`);
  return str;
};

// Parses a number, rejecting text, NaN and Infinity, and enforcing a range
const number = (value, { label, min, max, allowBlank = false, fallback = 0 }, errors) => {
  if (isBlank(value)) {
    if (allowBlank) return null;
    return fallback;
  }
  const n = parseDecimal(value);
  if (!Number.isFinite(n)) {
    errors.push(`${label} must be a number.`);
    return fallback;
  }
  if (n < min || n > max) errors.push(`${label} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`);
  return n;
};

const validateTemplatePayload = (body, { requireVersion = false } = {}) => {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  const data = {
    template_title: text(b.template_title, { label: 'Title', max: 200, required: true }, errors),
    description: text(b.description, { label: 'Notes / description', max: 5000 }, errors),
    // Currency is a saved currency (by id); its code is looked up by the controller
    currency_id: parseId(b.currency_id),
    solution_price_override: number(b.solution_price_override, { label: 'Quoted solution price', min: 0, max: LIMITS.money, allowBlank: true }, errors),
    cash_price_override: number(b.cash_price_override, { label: 'Quoted cash price', min: 0, max: LIMITS.money, allowBlank: true }, errors),
    version: null,
    spec_lines: [],
    sections: [],
    additional_costs: [],
    section2_additions: []
  };

  if (!data.currency_id) errors.push('Choose a currency for the template.');

  if (requireVersion) {
    const v = parseId(b.version);
    if (!v) errors.push('Missing template version. Reload the template and try again.');
    else data.version = v;
  }

  // Sections & line items
  if (!Array.isArray(b.sections) || b.sections.length === 0) {
    errors.push('At least one section is required.');
  } else if (b.sections.length > LIMITS.maxSections) {
    errors.push(`A template can have at most ${LIMITS.maxSections} sections.`);
  } else {
    let itemCount = 0;
    b.sections.forEach((section, sIdx) => {
      const sLabel = `Section ${sIdx + 1}`;
      const items = Array.isArray(section?.items) ? section.items : [];
      if (items.length > LIMITS.maxItemsPerSection) errors.push(`${sLabel} has more than ${LIMITS.maxItemsPerSection} line items.`);
      itemCount += items.length;

      data.sections.push({
        section_name: text(section?.section_name, { label: `${sLabel} name`, max: 150 }, errors),
        items: items.slice(0, LIMITS.maxItemsPerSection).map((item, iIdx) => {
          const iLabel = `${sLabel}, line ${iIdx + 1}`;
          const quantity = number(item?.quantity, { label: `${iLabel} quantity`, min: 0, max: LIMITS.qtyOrPrice }, errors);
          const unitPrice = number(item?.unit_price, { label: `${iLabel} price`, min: 0, max: LIMITS.qtyOrPrice }, errors);
          if (quantity * unitPrice > LIMITS.lineAmount) errors.push(`${iLabel} amount is too large.`);

          let materialId = null;
          if (!isBlank(item?.material_id)) {
            materialId = parseId(item.material_id);
            if (!materialId) {
              errors.push(`${iLabel} has an invalid inventory item.`);
              materialId = null;
            }
          }

          return {
            material_id: materialId,
            product_name: text(item?.product_name, { label: `${iLabel} description`, max: 150 }, errors),
            brand: text(item?.brand, { label: `${iLabel} brand / info`, max: 100 }, errors) || null,
            unit_of_measure: text(item?.unit_of_measure, { label: `${iLabel} unit`, max: 50 }, errors) || null,
            comment: text(item?.comment, { label: `${iLabel} comment`, max: 500 }, errors) || null,
            quantity,
            unit_price: unitPrice
          };
        })
      });
    });
    if (itemCount > LIMITS.maxItemsTotal) errors.push(`A template can have at most ${LIMITS.maxItemsTotal} line items in total.`);
  }

  // Additional costs
  const costs = b.additional_costs === undefined ? [] : b.additional_costs;
  if (!Array.isArray(costs)) {
    errors.push('Additions Section 1 must be a list.');
  } else if (costs.length > LIMITS.maxAdditionalCosts) {
    errors.push(`Additions Section 1 can have at most ${LIMITS.maxAdditionalCosts} rows.`);
  } else {
    costs.forEach((cost, idx) => {
      const label = `Additions Section 1, row ${idx + 1}`;
      const calcMode = cost?.calc_mode === 'amount' ? 'amount' : 'percent';
      if (cost?.calc_mode !== undefined && !['percent', 'amount'].includes(cost.calc_mode)) {
        errors.push(`${label} has an invalid type.`);
      }
      data.additional_costs.push({
        cost_name: text(cost?.cost_name, { label: `${label} name`, max: 150, required: true }, errors),
        calc_mode: calcMode,
        percentage: calcMode === 'percent'
          ? number(cost?.percentage, { label: `${label} %`, min: -100, max: 100 }, errors)
          : 0,
        amount: calcMode === 'amount'
          ? number(cost?.amount, { label: `${label} amount`, min: -LIMITS.money, max: LIMITS.money }, errors)
          : 0
      });
    });
  }

  // Spec lines (document header): title required, details optional
  const specLines = b.spec_lines === undefined ? [] : b.spec_lines;
  if (!Array.isArray(specLines)) {
    errors.push('Spec lines must be a list.');
  } else if (specLines.length > LIMITS.maxSpecLines) {
    errors.push(`At most ${LIMITS.maxSpecLines} spec lines are allowed.`);
  } else {
    specLines.forEach((line, idx) => {
      const label = `Spec line ${idx + 1}`;
      data.spec_lines.push({
        line_title: text(line?.line_title, { label: `${label} title`, max: 100, required: true }, errors),
        line_details: text(line?.line_details, { label: `${label} details`, max: 500 }, errors) || null
      });
    });
  }

  // Additional Section 2 (compounding rows after Total Cost)
  const section2 = b.section2_additions === undefined ? [] : b.section2_additions;
  if (!Array.isArray(section2)) {
    errors.push('Additional Section 2 must be a list.');
  } else if (section2.length > LIMITS.maxSection2Rows) {
    errors.push(`Additional Section 2 can have at most ${LIMITS.maxSection2Rows} rows.`);
  } else {
    section2.forEach((row, idx) => {
      const label = `Additional Section 2, row ${idx + 1}`;
      const calcMode = row?.calc_mode === 'amount' ? 'amount' : 'percent';
      if (row?.calc_mode !== undefined && !['percent', 'amount'].includes(row.calc_mode)) {
        errors.push(`${label} has an invalid type.`);
      }
      data.section2_additions.push({
        addition_name: text(row?.addition_name, { label: `${label} name`, max: 150, required: true }, errors),
        calc_mode: calcMode,
        percentage: calcMode === 'percent'
          ? number(row?.percentage, { label: `${label} %`, min: -99.99, max: 1000 }, errors)
          : 0,
        amount: calcMode === 'amount'
          ? number(row?.amount, { label: `${label} amount`, min: -LIMITS.money, max: LIMITS.money }, errors)
          : 0,
        include_in_cash_price: (() => {
          if (row?.include_in_cash_price === undefined) return true;
          const flag = parseBoolean(row.include_in_cash_price);
          if (flag === undefined) errors.push(`${label} "In cash" must be true or false.`);
          return flag ?? true;
        })()
      });
    });
  }

  return { data, errors };
};

// Checks that only make sense after pricing is calculated
const validatePricingResult = (pricing, sections = []) => {
  const errors = [];
  sections.forEach((section, idx) => {
    if (Math.abs(sectionSubtotal(section)) > LIMITS.lineAmount) errors.push(`Section ${idx + 1} total is too large.`);
  });
  if (Math.abs(pricing.subtotal) > LIMITS.money) errors.push('Items subtotal is too large.');
  if (pricing.totalCost < 0) {
    errors.push('Additions Section 1 reduces Total Cost below zero. Reduce the negative rows.');
  }
  pricing.costs.forEach((cost, idx) => {
    if (Math.abs(cost.percentage) > LIMITS.derivedPercent) errors.push(`Additions Section 1, row ${idx + 1} is too large compared to the items subtotal.`);
    if (Math.abs(cost.amount) > LIMITS.money) errors.push(`Additions Section 1, row ${idx + 1} amount is too large.`);
  });
  pricing.section2.forEach((row, idx) => {
    if (row.running_total < 0) errors.push(`Additional Section 2, row ${idx + 1} takes the running total below zero.`);
    if (Math.abs(row.percentage) > LIMITS.derivedPercent) errors.push(`Additional Section 2, row ${idx + 1} is too large compared to the running total.`);
  });
  if (pricing.cashPriceCalculated < 0) errors.push('Cash price is below zero.');
  [['Total Cost', pricing.totalCost], ['Solution price', pricing.solutionPriceCalculated], ['Cash price', pricing.cashPriceCalculated],
    ['Quoted solution price', pricing.solutionPrice], ['Quoted cash price', pricing.cashPrice]].forEach(([label, value]) => {
    if (Math.abs(value) > LIMITS.money) errors.push(`${label} is too large.`);
  });
  return errors;
};

module.exports = { LIMITS, validateTemplatePayload, validatePricingResult };
