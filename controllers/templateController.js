const db = require('../config/db');
const { sendServerError, parseId, sendInvalidId } = require('../utils/http');
const { calculatePricing, lineAmount, sectionSubtotal } = require('../utils/pricing');
const { validateTemplatePayload, validatePricingResult } = require('../utils/templateValidation');

// Header columns written on create/update, in order. Retired (kept in the table, no longer
// written): spec_panels / spec_inverter / spec_battery / spec_other → template_spec_lines;
// sales_commission_percentage → Additions Section 1 (template_additional_costs);
// gross_profit_percentage / risk_markup_percentage → Additional Section 2 (template_section2_additions)
// `currency` (code text) is kept in step with `currency_id` for the list and older readers.
const HEADER_COLUMNS = [
  'template_title', 'description', 'currency_id', 'currency',
  'solution_price_override', 'cash_price_override',
  'grand_total', 'cash_price'
];

const headerValues = (data, pricing) => [
  data.template_title,
  data.description,
  data.currency_id,
  data.currency,
  data.solution_price_override,
  data.cash_price_override,
  pricing.solutionPrice,
  pricing.cashPrice
];

const badRequest = (res, errors) =>
  res.status(400).json({ success: false, message: errors[0], errors });

// Validate the payload, check referenced inventory items exist, and price it on the server.
// The browser's own totals are never trusted; every amount is recalculated here.
const preparePayload = async (body, options) => {
  const { data, errors } = validateTemplatePayload(body, options);
  if (errors.length) return { errors };

  const [currencyRows] = await db.query('SELECT currency_code, is_active FROM currencies WHERE currency_id = ?', [data.currency_id]);
  if (currencyRows.length === 0) return { errors: ['The selected currency no longer exists. Choose another one.'] };
  // New templates (and templates moved to another currency) need an active currency;
  // a template already in an inactive currency can still be edited
  if (!Number(currencyRows[0].is_active) && options?.currentCurrencyId !== data.currency_id) {
    return { errors: [`${currencyRows[0].currency_code} is inactive. Activate it on the Currencies page, or choose another currency.`] };
  }
  data.currency = currencyRows[0].currency_code;

  // Every inventory line must exist and be priced in the template's currency
  const materialIds = [...new Set(data.sections.flatMap((s) => s.items.map((i) => i.material_id)).filter(Boolean))];
  if (materialIds.length) {
    const [rows] = await db.query(
      `SELECT m.id, m.material_id, m.currency_id, c.currency_code
       FROM materials m JOIN currencies c ON c.currency_id = m.currency_id WHERE m.id IN (?)`,
      [materialIds]
    );
    const found = new Map(rows.map((r) => [r.id, r]));
    const missing = materialIds.filter((id) => !found.has(id));
    if (missing.length) {
      return { errors: [`Some line items refer to inventory items that no longer exist (ids: ${missing.join(', ')}). Pick them again.`] };
    }
    const wrongCurrency = rows.filter((r) => r.currency_id !== data.currency_id);
    if (wrongCurrency.length) {
      return {
        errors: [`These items are not in ${data.currency}: ${wrongCurrency.map((r) => `${r.material_id} (${r.currency_code})`).join(', ')}. Pick the ${data.currency} version or remove them.`]
      };
    }
  }

  const pricing = calculatePricing({
    sections: data.sections,
    additionalCosts: data.additional_costs,
    section2Additions: data.section2_additions,
    solutionPriceOverride: data.solution_price_override,
    cashPriceOverride: data.cash_price_override
  });
  const pricingErrors = validatePricingResult(pricing, data.sections);
  if (pricingErrors.length) return { errors: pricingErrors };

  return { data, pricing };
};

// Insert spec lines, sections, line items, Section 1 and Section 2 rows (inside the caller's transaction)
const insertChildren = async (connection, templateId, data, pricing) => {
  for (let i = 0; i < data.spec_lines.length; i++) {
    const line = data.spec_lines[i];
    await connection.execute(
      `INSERT INTO template_spec_lines (template_id, line_title, line_details, sort_order)
       VALUES (?, ?, ?, ?)`,
      [templateId, line.line_title, line.line_details, i + 1]
    );
  }

  for (let i = 0; i < data.sections.length; i++) {
    const section = data.sections[i];
    const [sectionResult] = await connection.execute(
      `INSERT INTO template_sections (template_id, section_name, section_order, section_subtotal)
       VALUES (?, ?, ?, ?)`,
      [templateId, section.section_name, i + 1, sectionSubtotal(section)]
    );
    const sectionId = sectionResult.insertId;

    for (const item of section.items) {
      await connection.execute(
        `INSERT INTO template_items (section_id, material_id, product_name, brand, comment, unit_price, quantity, unit_of_measure, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sectionId,
          item.material_id,
          item.product_name,
          item.brand,
          item.comment,
          item.unit_price,
          item.quantity,
          item.unit_of_measure,
          lineAmount(item)
        ]
      );
    }
  }

  for (let i = 0; i < pricing.costs.length; i++) {
    const cost = pricing.costs[i];
    await connection.execute(
      `INSERT INTO template_additional_costs (template_id, cost_name, calc_mode, percentage, amount, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [templateId, cost.cost_name, cost.calc_mode, cost.percentage, cost.amount, i + 1]
    );
  }

  for (let i = 0; i < pricing.section2.length; i++) {
    const row = pricing.section2[i];
    await connection.execute(
      `INSERT INTO template_section2_additions
         (template_id, addition_name, calc_mode, percentage, base_amount, amount, include_in_cash_price, cash_amount, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [templateId, row.addition_name, row.calc_mode, row.percentage, row.base_amount, row.amount,
        row.include_in_cash_price ? 1 : 0, row.cash_amount, i + 1]
    );
  }
};

// GET /api/templates - List all saved templates (newest first)
exports.getAllTemplates = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT t.template_id, t.template_title, t.description, t.currency_id,
             COALESCE(c.currency_code, t.currency) AS currency, c.decimal_places AS currency_decimals,
             t.grand_total, t.cash_price, t.created_at,
             COUNT(s.section_id) AS section_count
      FROM templates t
      LEFT JOIN currencies c ON c.currency_id = t.currency_id
      LEFT JOIN template_sections s ON s.template_id = t.template_id
      GROUP BY t.template_id
      ORDER BY t.created_at DESC, t.template_id DESC
    `);

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    sendServerError(res, 'Failed to fetch templates', error);
  }
};

// POST /api/templates - Create a new sectioned template
exports.createTemplate = async (req, res) => {
  let connection;
  try {
    const { data, pricing, errors } = await preparePayload(req.body);
    if (errors) return badRequest(res, errors);

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [templateResult] = await connection.execute(
      `INSERT INTO templates (${HEADER_COLUMNS.join(', ')}, version) VALUES (${HEADER_COLUMNS.map(() => '?').join(', ')}, 1)`,
      headerValues(data, pricing)
    );
    const templateId = templateResult.insertId;

    await insertChildren(connection, templateId, data, pricing);
    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Template created successfully!',
      template_id: templateId,
      version: 1,
      grand_total: pricing.solutionPrice
    });
  } catch (error) {
    if (connection) await connection.rollback();
    sendServerError(res, 'Failed to create template', error);
  } finally {
    if (connection) connection.release();
  }
};

// PUT /api/templates/:id - Replace an existing template's header, sections, items & costs.
// The request must carry the version it was loaded with; if someone saved in between,
// the update is refused (409) instead of silently overwriting their changes.
exports.updateTemplate = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return sendInvalidId(res);

  let connection;
  try {
    const [existingTemplate] = await db.query('SELECT currency_id FROM templates WHERE template_id = ?', [id]);
    if (existingTemplate.length === 0) return res.status(404).json({ success: false, message: 'Template not found' });
    const { data, pricing, errors } = await preparePayload(req.body, {
      requireVersion: true,
      currentCurrencyId: existingTemplate[0].currency_id
    });
    if (errors) return badRequest(res, errors);

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [updateResult] = await connection.execute(
      `UPDATE templates SET ${HEADER_COLUMNS.map((c) => `${c} = ?`).join(', ')}, version = version + 1
       WHERE template_id = ? AND version = ?`,
      [...headerValues(data, pricing), id, data.version]
    );

    if (updateResult.affectedRows === 0) {
      await connection.rollback();
      const [existing] = await db.query('SELECT version FROM templates WHERE template_id = ?', [id]);
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Template not found' });
      }
      return res.status(409).json({
        success: false,
        message: 'This template was changed somewhere else after you opened it. Reload it to get the latest version, then re-apply your changes.',
        current_version: existing[0].version
      });
    }

    // Old items are removed via ON DELETE CASCADE from template_sections
    await connection.execute('DELETE FROM template_sections WHERE template_id = ?', [id]);
    await connection.execute('DELETE FROM template_additional_costs WHERE template_id = ?', [id]);
    await connection.execute('DELETE FROM template_section2_additions WHERE template_id = ?', [id]);
    await connection.execute('DELETE FROM template_spec_lines WHERE template_id = ?', [id]);
    await insertChildren(connection, id, data, pricing);

    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Template updated successfully!',
      template_id: id,
      version: data.version + 1,
      grand_total: pricing.solutionPrice
    });
  } catch (error) {
    if (connection) await connection.rollback();
    sendServerError(res, 'Failed to update template', error);
  } finally {
    if (connection) connection.release();
  }
};

// GET /api/templates/:id - Get template by ID with all sections, items & additional costs
exports.getTemplateById = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return sendInvalidId(res);

  try {
    const [templates] = await db.query(
      `SELECT t.*, c.currency_code, c.currency_name, c.symbol AS currency_symbol, c.decimal_places AS currency_decimals
       FROM templates t LEFT JOIN currencies c ON c.currency_id = t.currency_id
       WHERE t.template_id = ?`,
      [id]
    );

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const [sections] = await db.query(
      'SELECT * FROM template_sections WHERE template_id = ? ORDER BY section_order ASC',
      [id]
    );

    for (const section of sections) {
      const [items] = await db.query(
        'SELECT * FROM template_items WHERE section_id = ? ORDER BY item_id ASC',
        [section.section_id]
      );
      section.items = items;
    }

    const [additionalCosts] = await db.query(
      'SELECT cost_id, cost_name, calc_mode, percentage, amount, sort_order FROM template_additional_costs WHERE template_id = ? ORDER BY sort_order ASC, cost_id ASC',
      [id]
    );

    const [section2Additions] = await db.query(
      `SELECT addition_id, addition_name, calc_mode, percentage, base_amount, amount, include_in_cash_price, cash_amount, sort_order
       FROM template_section2_additions WHERE template_id = ? ORDER BY sort_order ASC, addition_id ASC`,
      [id]
    );

    const [specLines] = await db.query(
      `SELECT spec_line_id, line_title, line_details, sort_order
       FROM template_spec_lines WHERE template_id = ? ORDER BY sort_order ASC, spec_line_id ASC`,
      [id]
    );

    res.status(200).json({
      success: true,
      data: {
        ...templates[0],
        sections,
        additional_costs: additionalCosts,
        section2_additions: section2Additions,
        spec_lines: specLines
      }
    });
  } catch (error) {
    sendServerError(res, 'Failed to fetch template', error);
  }
};

// GET /api/templates/section-topics - Get all unique section names previously used
exports.getExistingSectionTopics = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT section_name
      FROM template_sections
      WHERE section_name IS NOT NULL AND TRIM(section_name) != ''
      ORDER BY section_name ASC
    `);

    res.status(200).json({ success: true, data: rows.map((r) => r.section_name) });
  } catch (error) {
    sendServerError(res, 'Failed to fetch section topics', error);
  }
};

// GET /api/templates/cost-names - Additional cost names used before (for suggestions)
exports.getExistingCostNames = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT cost_name
      FROM template_additional_costs
      WHERE TRIM(cost_name) != ''
      ORDER BY cost_name ASC
    `);

    res.status(200).json({ success: true, data: rows.map((r) => r.cost_name) });
  } catch (error) {
    sendServerError(res, 'Failed to fetch cost names', error);
  }
};

// GET /api/templates/section2-names - Additional Section 2 row names used before (for suggestions)
exports.getExistingSection2Names = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT addition_name
      FROM template_section2_additions
      WHERE TRIM(addition_name) != ''
      ORDER BY addition_name ASC
    `);

    res.status(200).json({ success: true, data: rows.map((r) => r.addition_name) });
  } catch (error) {
    sendServerError(res, 'Failed to fetch Additional Section 2 names', error);
  }
};

// GET /api/templates/spec-titles - Spec line titles used before (for suggestions)
exports.getExistingSpecTitles = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT line_title
      FROM template_spec_lines
      WHERE TRIM(line_title) != ''
      ORDER BY line_title ASC
    `);

    res.status(200).json({ success: true, data: rows.map((r) => r.line_title) });
  } catch (error) {
    sendServerError(res, 'Failed to fetch spec line titles', error);
  }
};
