const db = require('../config/db');
const { sendServerError, parseId, sendInvalidId } = require('../utils/http');
const { round2 } = require('../utils/pricing');
const { parseDecimal, parseId: parseIdValue, isTextLike } = require('../utils/parse');
const { FIELDS: CURRENCY_FIELDS, normalizeCurrency } = require('../utils/currencyValidation');
const { SUPPLIER_FIELDS, normalizeSupplier } = require('../utils/supplierValidation');

// Editable columns on the materials table, with limits matching the column definitions
const FIELD_RULES = {
  material_id: { label: 'Material ID', max: 50, required: true },
  item_code: { label: 'Item code', max: 50 },
  brand: { label: 'Brand', max: 100 },
  product_name: { label: 'Product name', max: 150, required: true },
  model_no: { label: 'Model no.', max: 100 },
  description_1: { label: 'Description 1', max: 2000 },
  description_2: { label: 'Description 2', max: 2000 },
  description_3: { label: 'Description 3', max: 2000 },
  currency_id: { label: 'Currency', currency: true },
  supplier_id: { label: 'Supplier', supplier: true },
  max_retail_price: { label: 'MRP', number: true, maxValue: 99999999.99 },        // DECIMAL(10,2)
  purchase_discount: { label: 'Purchase discount %', number: true, maxValue: 100 },  // DECIMAL(5,2), a percentage
  dealer_price: { label: 'Dealer price', number: true, maxValue: 99999999.99 },
  warranty_period: { label: 'Warranty period', max: 50 },
  unit_of_material: { label: 'Unit', max: 50 },
  amount: { label: 'Amount', number: true, maxValue: 99999999.99 }
};
const MATERIAL_FIELDS = Object.keys(FIELD_RULES);

const MAX_BULK_ROWS = 1000;
const MAX_IMPORT_ROWS = 2000;

// Trim strings, turn blanks into null / 0, and validate one material payload.
// Returns { data, errors } where errors is a list of messages.
// refs = { supplierIds: Set, currencies: { byId: Set, byCode: Map(code -> id) } }
const normalizeMaterial = (input, refs) => {
  const { supplierIds, currencies } = refs;
  const data = {};
  const errors = [];
  const source = input && typeof input === 'object' ? input : {};

  MATERIAL_FIELDS.forEach((field) => {
    const rule = FIELD_RULES[field];
    const raw = source[field];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    const blank = value === '' || value === undefined || value === null;

    if (rule.number) {
      if (blank) {
        data[field] = 0;
        return;
      }
      const n = parseDecimal(value);
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`${rule.label} must be a positive number`);
        data[field] = 0;
      } else if (n > rule.maxValue) {
        errors.push(`${rule.label} cannot exceed ${rule.maxValue.toLocaleString('en-US')}`);
        data[field] = 0;
      } else {
        data[field] = round2(n);
      }
      return;
    }

    if (rule.currency) {
      // Accepts currency_id (forms) or currency_code (Excel import)
      let currencyId = blank ? null : parseIdValue(value) ?? NaN;
      if (currencyId === null && source.currency_code) {
        currencyId = currencies.byCode.get(String(source.currency_code).trim().toUpperCase()) ?? null;
        if (currencyId === null) errors.push(`Currency ${String(source.currency_code).trim()} does not exist`);
      } else if (currencyId === null) {
        errors.push('Currency is required');
      } else if (!Number.isInteger(currencyId) || !currencies.byId.has(currencyId)) {
        errors.push(`Currency ${value} does not exist`);
        currencyId = null;
      }
      data[field] = currencyId;
      return;
    }

    if (rule.supplier) {
      if (blank) {
        data[field] = null;
        return;
      }
      const supplierId = parseIdValue(value);
      if (!supplierId || !supplierIds.has(supplierId)) {
        errors.push(`Supplier ID ${value} does not exist`);
        data[field] = null;
      } else {
        data[field] = supplierId;
      }
      return;
    }

    if (!blank && !isTextLike(value)) {
      errors.push(`${rule.label} must be text`);
      data[field] = null;
      return;
    }
    const str = blank ? '' : String(value);
    if (rule.required && !str) errors.push(`${rule.label} is required`);
    if (str.length > rule.max) errors.push(`${rule.label} must be at most ${rule.max} characters`);
    data[field] = str || null;
  });

  return { data, errors };
};

// Lookup data needed to validate items: supplier ids and currencies
// conn: the pool, or a transaction connection (then rows added in that transaction count)
const loadRefs = async (conn = db) => {
  const [[suppliers], [currencyRows]] = await Promise.all([
    conn.query('SELECT supplier_id FROM supplier_details'),
    conn.query('SELECT currency_id, currency_code, is_active FROM currencies')
  ]);
  return {
    supplierIds: new Set(suppliers.map((r) => r.supplier_id)),
    currencies: {
      byId: new Set(currencyRows.map((r) => r.currency_id)),
      activeIds: new Set(currencyRows.filter((r) => Number(r.is_active)).map((r) => r.currency_id)),
      byCode: new Map(currencyRows.map((r) => [r.currency_code, r.currency_id]))
    }
  };
};

const currencyCodeOf = async (currencyId) => {
  const [rows] = await db.query('SELECT currency_code FROM currencies WHERE currency_id = ?', [currencyId]);
  return rows[0]?.currency_code || 'this currency';
};


// A new item (or an item moved to another currency) must use an active currency
const inactiveCurrencyError = (data, refs) =>
  data.currency_id && !refs.currencies.activeIds.has(data.currency_id)
    ? 'This currency is inactive. Activate it on the Currencies page, or choose another currency.'
    : null;

const conflictResponse = (res, message, extra = {}) =>
  res.status(409).json({ success: false, message, ...extra });

// GET /api/materials - Get all materials with supplier info
exports.getAllMaterials = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        m.*,
        c.currency_code,
        c.currency_name,
        c.symbol AS currency_symbol,
        c.decimal_places AS currency_decimals,
        s.company_name AS supplier_name,
        s.contact_person,
        s.email AS supplier_email,
        s.lead_time_days
      FROM materials m
      LEFT JOIN supplier_details s ON m.supplier_id = s.supplier_id
      LEFT JOIN currencies c ON m.currency_id = c.currency_id
      ORDER BY m.id ASC
    `);

    res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    sendServerError(res, 'Failed to fetch materials', error);
  }
};

// GET /api/materials/suppliers - Supplier list for dropdowns & the Excel sample
exports.getSuppliers = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT supplier_id, company_name, contact_person, status FROM supplier_details ORDER BY supplier_id ASC'
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    sendServerError(res, 'Failed to fetch suppliers', error);
  }
};

// GET /api/materials/:id - One material with full supplier details
exports.getMaterialById = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return sendInvalidId(res);

  try {
    const [rows] = await db.query(`
      SELECT
        m.*,
        c.currency_code,
        c.currency_name,
        c.symbol AS currency_symbol,
        c.decimal_places AS currency_decimals,
        s.company_name AS supplier_name,
        s.contact_person,
        s.email AS supplier_email,
        s.phone AS supplier_phone,
        s.payment_terms,
        s.lead_time_days
      FROM materials m
      LEFT JOIN supplier_details s ON m.supplier_id = s.supplier_id
      LEFT JOIN currencies c ON m.currency_id = c.currency_id
      WHERE m.id = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    sendServerError(res, 'Failed to fetch material', error);
  }
};

// POST /api/materials - Add one new material
exports.createMaterial = async (req, res) => {
  try {
    const refs = await loadRefs();
    const { data, errors } = normalizeMaterial(req.body, refs);
    const inactive = inactiveCurrencyError(data, refs);
    if (inactive) errors.push(inactive);
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join('. '), errors });
    }

    const [result] = await db.execute(
      `INSERT INTO materials (${MATERIAL_FIELDS.join(', ')}, version) VALUES (${MATERIAL_FIELDS.map(() => '?').join(', ')}, 1)`,
      MATERIAL_FIELDS.map((f) => data[f])
    );

    res.status(201).json({ success: true, message: 'Material created successfully!', id: result.insertId, version: 1 });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return conflictResponse(res, `Material ID "${String(req.body?.material_id ?? '').slice(0, 50)}" already exists in ${await currencyCodeOf(Number(req.body?.currency_id))}.`);
    }
    sendServerError(res, 'Failed to create material', error);
  }
};

// PUT /api/materials/:id - Update one material.
// Must carry the version it was loaded with; a newer save in between returns 409.
exports.updateMaterial = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return sendInvalidId(res);

  try {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) {
      return res.status(400).json({ success: false, message: 'Missing item version. Reload the item and try again.' });
    }

    const refs = await loadRefs();
    const { data, errors } = normalizeMaterial(req.body, refs);
    if (errors.length) {
      return res.status(400).json({ success: false, message: errors.join('. '), errors });
    }

    const [current] = await db.query('SELECT currency_id FROM materials WHERE id = ?', [id]);
    if (current.length === 0) return res.status(404).json({ success: false, message: 'Material not found' });
    if (current[0].currency_id !== data.currency_id) {
      const inactive = inactiveCurrencyError(data, refs);
      if (inactive) return res.status(400).json({ success: false, message: inactive, errors: [inactive] });
      // Saved templates using this item would end up with an item in the wrong currency
      const [usedIn] = await db.query(
        `SELECT DISTINCT t.template_id, t.template_title
         FROM template_items i
         JOIN template_sections s ON s.section_id = i.section_id
         JOIN templates t ON t.template_id = s.template_id
         WHERE i.material_id = ? AND t.currency_id <> ?
         ORDER BY t.template_id LIMIT 10`,
        [String(id), data.currency_id]
      );
      if (usedIn.length) {
        return conflictResponse(res, `This item is used in saved templates (${usedIn.map((t) => `#${t.template_id} ${t.template_title}`).join(', ')}), so its currency can't change. Add a separate item in the new currency instead (same Material ID and Item Code).`, { templates: usedIn });
      }
    }

    const [result] = await db.execute(
      `UPDATE materials SET ${MATERIAL_FIELDS.map((f) => `${f} = ?`).join(', ')}, version = version + 1
       WHERE id = ? AND version = ?`,
      [...MATERIAL_FIELDS.map((f) => data[f]), id, version]
    );

    if (result.affectedRows === 0) {
      const [existing] = await db.query('SELECT version FROM materials WHERE id = ?', [id]);
      if (existing.length === 0) {
        return res.status(404).json({ success: false, message: 'Material not found' });
      }
      return conflictResponse(res, 'This item was changed somewhere else after you opened it. Reload it to get the latest version, then re-apply your changes.', {
        current_version: existing[0].version
      });
    }

    res.status(200).json({ success: true, message: 'Material updated successfully!', version: version + 1 });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return conflictResponse(res, `Material ID "${String(req.body?.material_id ?? '').slice(0, 50)}" is already used by another item in ${await currencyCodeOf(Number(req.body?.currency_id))}.`);
    }
    sendServerError(res, 'Failed to update material', error);
  }
};

// PUT /api/materials/bulk - Update many materials at once.
// Body: { items: [{ id, version, ...materialFields }] }
// Material ID and Item Code are identifiers and are never changed here.
// All rows are validated first; if any row is invalid or was changed elsewhere, nothing is saved.
const BULK_LOCKED_FIELDS = ['material_id', 'item_code', 'currency_id'];
const BULK_UPDATE_FIELDS = MATERIAL_FIELDS.filter((f) => !BULK_LOCKED_FIELDS.includes(f));

exports.bulkUpdateMaterials = async (req, res) => {
  const items = req.body?.items;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items to update.' });
  }
  if (items.length > MAX_BULK_ROWS) {
    return res.status(400).json({ success: false, message: `At most ${MAX_BULK_ROWS} items can be saved at once.` });
  }

  let connection;
  try {
    const refs = await loadRefs();
    const [existingRows] = await db.query('SELECT id, material_id, item_code, currency_id, version FROM materials');
    const existingById = new Map(existingRows.map((r) => [r.id, r]));

    const errors = [];
    const conflicts = [];
    const updates = [];

    items.forEach((item) => {
      const existing = existingById.get(Number(item?.id));
      if (!existing) {
        errors.push({ id: item?.id ?? null, material_id: item?.material_id ?? null, messages: ['Item no longer exists'] });
        return;
      }
      const version = Number(item.version);
      if (!Number.isInteger(version) || version !== existing.version) {
        conflicts.push({ id: existing.id, material_id: existing.material_id });
        return;
      }
      // Validate against the stored identifiers so the locked fields can't be changed or blanked
      const { data, errors: rowErrors } = normalizeMaterial(
        { ...item, material_id: existing.material_id, item_code: existing.item_code, currency_id: existing.currency_id },
        refs
      );
      if (rowErrors.length) {
        errors.push({ id: existing.id, material_id: existing.material_id, messages: rowErrors });
        return;
      }
      updates.push({ id: existing.id, version, data });
    });

    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: `${errors.length} item${errors.length > 1 ? 's have' : ' has'} invalid values. Nothing was saved.`,
        errors
      });
    }
    if (conflicts.length) {
      return conflictResponse(res, `${conflicts.length} item${conflicts.length > 1 ? 's were' : ' was'} changed somewhere else since you loaded the list. Nothing was saved — reload and re-apply your changes.`, { conflicts });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    for (const { id, version, data } of updates) {
      const [result] = await connection.execute(
        `UPDATE materials SET ${BULK_UPDATE_FIELDS.map((f) => `${f} = ?`).join(', ')}, version = version + 1
         WHERE id = ? AND version = ?`,
        [...BULK_UPDATE_FIELDS.map((f) => data[f]), id, version]
      );
      // Someone saved this row between our check and now: undo everything
      if (result.affectedRows === 0) {
        await connection.rollback();
        return conflictResponse(res, 'An item was changed somewhere else while saving. Nothing was saved — reload and re-apply your changes.', {
          conflicts: [{ id, material_id: existingById.get(id).material_id }]
        });
      }
    }
    await connection.commit();

    res.status(200).json({ success: true, message: `${updates.length} item${updates.length === 1 ? '' : 's'} updated.`, updated: updates.length });
  } catch (error) {
    if (connection) await connection.rollback();
    sendServerError(res, 'Failed to update materials', error);
  } finally {
    if (connection) connection.release();
  }
};

// POST /api/materials/import - Bulk import from the Excel workbook.
// Body: { items: [{ row, ...materialFields }], currencies?: [{ row, ...currencyFields }],
//         suppliers?: [{ row, supplier_id, ...supplierFields }] }
// Everything runs in ONE transaction, in this order:
//   1. Currencies sheet: codes that don't exist yet are created; existing codes are left unchanged.
//   2. Suppliers sheet: IDs that don't exist yet are created WITH that ID (the Items sheet refers to
//      it); an ID that exists with the same company name is left unchanged; an ID used by a
//      different company is an error.
//   3. Items sheet: valid new rows are inserted and may use the currencies / suppliers from 1 and 2.
//      Rows whose Material ID already exists in that currency are skipped and returned in
//      `duplicates`.
const MAX_SHEET_ROWS = 1000;
// Sheet IDs are kept as given; a cap keeps them inside INT and stops one typo from pushing the
// next automatic supplier ID into the billions.
const MAX_SUPPLIER_ID = 999999;

const sheetRow = (item, idx) => parseIdValue(item?.row) || idx + 2;
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

exports.importMaterials = async (req, res) => {
  const items = req.body?.items ?? [];
  const currencyRows = req.body?.currencies ?? [];
  const supplierRows = req.body?.suppliers ?? [];

  if (![items, currencyRows, supplierRows].every(Array.isArray)) {
    return res.status(400).json({ success: false, message: 'items, currencies and suppliers must be lists.' });
  }
  if (items.length + currencyRows.length + supplierRows.length === 0) {
    return res.status(400).json({ success: false, message: 'Nothing to import.' });
  }
  if (items.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({ success: false, message: `At most ${MAX_IMPORT_ROWS} item rows can be imported at once. Split the file.` });
  }
  if (currencyRows.length > MAX_SHEET_ROWS || supplierRows.length > MAX_SHEET_ROWS) {
    return res.status(400).json({ success: false, message: `At most ${MAX_SHEET_ROWS} currency / supplier rows can be imported at once.` });
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Currencies
    const currencyResults = [];
    const [existingCurrencies] = await connection.query('SELECT currency_code FROM currencies');
    const knownCodes = new Set(existingCurrencies.map((c) => c.currency_code));
    const seenCodes = new Map();
    for (const [idx, row] of currencyRows.entries()) {
      const rowNo = sheetRow(row, idx);
      const statusText = String(row?.status ?? '').trim().toLowerCase();
      const { data, errors } = normalizeCurrency({ ...row, is_active: statusText !== 'inactive' });
      if (!['', 'active', 'inactive'].includes(statusText)) errors.push('Status must be Active or Inactive');
      if (data.currency_code && knownCodes.has(data.currency_code)) {
        currencyResults.push({ row: rowNo, currency_code: data.currency_code, result: 'existing' });
        continue;
      }
      if (data.currency_code && seenCodes.has(data.currency_code)) {
        errors.push(`Currency ${data.currency_code} repeats row ${seenCodes.get(data.currency_code)}`);
      }
      if (errors.length) {
        currencyResults.push({ row: rowNo, currency_code: data.currency_code || null, result: 'error', messages: errors });
        continue;
      }
      await connection.execute(
        `INSERT INTO currencies (${CURRENCY_FIELDS.join(', ')}, version) VALUES (${CURRENCY_FIELDS.map(() => '?').join(', ')}, 1)`,
        CURRENCY_FIELDS.map((f) => data[f])
      );
      seenCodes.set(data.currency_code, rowNo);
      currencyResults.push({ row: rowNo, currency_code: data.currency_code, result: 'created' });
    }

    // 2. Suppliers (keep the IDs from the sheet)
    const supplierResults = [];
    const [existingSuppliers] = await connection.query('SELECT supplier_id, company_name FROM supplier_details');
    const knownSuppliers = new Map(existingSuppliers.map((s) => [s.supplier_id, s.company_name]));
    for (const [idx, row] of supplierRows.entries()) {
      const rowNo = sheetRow(row, idx);
      const supplierId = parseIdValue(row?.supplier_id);
      const { data, errors } = normalizeSupplier(row);
      if (!supplierId || supplierId > MAX_SUPPLIER_ID) errors.unshift(`Supplier ID must be a whole number from 1 to ${MAX_SUPPLIER_ID}`);
      if (supplierId && knownSuppliers.has(supplierId)) {
        if (sameName(knownSuppliers.get(supplierId), data.company_name)) {
          supplierResults.push({ row: rowNo, supplier_id: supplierId, company_name: data.company_name, result: 'existing' });
        } else {
          supplierResults.push({
            row: rowNo, supplier_id: supplierId, company_name: data.company_name, result: 'error',
            messages: [`Supplier ID ${supplierId} is already used by "${knownSuppliers.get(supplierId)}"`]
          });
        }
        continue;
      }
      if (errors.length) {
        supplierResults.push({ row: rowNo, supplier_id: supplierId, company_name: data.company_name, result: 'error', messages: errors });
        continue;
      }
      await connection.execute(
        `INSERT INTO supplier_details (supplier_id, ${SUPPLIER_FIELDS.join(', ')}, version) VALUES (?, ${SUPPLIER_FIELDS.map(() => '?').join(', ')}, 1)`,
        [supplierId, ...SUPPLIER_FIELDS.map((f) => data[f])]
      );
      knownSuppliers.set(supplierId, data.company_name);
      supplierResults.push({ row: rowNo, supplier_id: supplierId, company_name: data.company_name, result: 'created' });
    }

    // 3. Items — validated against currencies / suppliers including the ones just created
    const refs = await loadRefs(connection);
    const [existingRows] = await connection.query(
      `SELECT m.id, m.material_id, m.currency_id, c.currency_code, m.product_name, m.brand, m.dealer_price
       FROM materials m JOIN currencies c ON c.currency_id = m.currency_id`
    );
    // Key = Material ID + currency: the same Material ID may exist once per currency
    const keyOf = (materialId, currencyId) => `${String(materialId).toLowerCase()}|${currencyId}`;
    const existingById = new Map(existingRows.map((r) => [keyOf(r.material_id, r.currency_id), r]));

    const toInsert = [];
    const duplicates = [];
    const errors = [];
    const seenInFile = new Map();

    items.forEach((item, idx) => {
      const row = sheetRow(item, idx);
      const { data, errors: rowErrors } = normalizeMaterial(item, refs);
      const inactive = inactiveCurrencyError(data, refs);
      if (inactive) rowErrors.push(inactive);

      if (rowErrors.length) {
        errors.push({ row, material_id: data.material_id, messages: rowErrors });
        return;
      }

      const key = keyOf(data.material_id, data.currency_id);
      if (existingById.has(key)) {
        duplicates.push({ row, incoming: data, existing: existingById.get(key) });
        return;
      }
      if (seenInFile.has(key)) {
        errors.push({ row, material_id: data.material_id, messages: [`Material ID repeats row ${seenInFile.get(key)} in the file (same currency)`] });
        return;
      }

      seenInFile.set(key, row);
      toInsert.push({ row, data });
    });

    for (const { data } of toInsert) {
      await connection.execute(
        `INSERT INTO materials (${MATERIAL_FIELDS.join(', ')}, version) VALUES (${MATERIAL_FIELDS.map(() => '?').join(', ')}, 1)`,
        MATERIAL_FIELDS.map((f) => data[f])
      );
    }
    await connection.commit();

    res.status(200).json({
      success: true,
      currencies: currencyResults,
      suppliers: supplierResults,
      inserted: toInsert.map(({ row, data }) => ({ row, material_id: data.material_id, product_name: data.product_name })),
      duplicates,
      errors
    });
  } catch (error) {
    if (connection) await connection.rollback();
    // A Material ID / supplier ID / currency added elsewhere mid-import: the whole import was rolled back
    if (error.code === 'ER_DUP_ENTRY') {
      return conflictResponse(res, 'Some of these records were added somewhere else while importing. Nothing was imported — try again.');
    }
    sendServerError(res, 'Failed to import materials', error);
  } finally {
    if (connection) connection.release();
  }
};
