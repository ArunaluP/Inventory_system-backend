const db = require('../config/db');
const { sendServerError, parseId, sendInvalidId } = require('../utils/http');
const { FIELDS, normalizeCurrency } = require('../utils/currencyValidation');

// Currencies are never deleted (items and templates reference them); set is_active = 0 to
// hide one from pickers while keeping it for existing items and templates.


// GET /api/currencies — all currencies with how many items / templates use each
exports.getAllCurrencies = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM materials m WHERE m.currency_id = c.currency_id) AS item_count,
        (SELECT COUNT(*) FROM templates t WHERE t.currency_id = c.currency_id) AS template_count
      FROM currencies c
      ORDER BY c.is_active DESC, c.currency_code ASC
    `);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    sendServerError(res, 'Failed to fetch currencies', error);
  }
};

// POST /api/currencies
exports.createCurrency = async (req, res) => {
  const { data, errors } = normalizeCurrency(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  try {
    const [result] = await db.execute(
      `INSERT INTO currencies (${FIELDS.join(', ')}, version) VALUES (${FIELDS.map(() => '?').join(', ')}, 1)`,
      FIELDS.map((f) => data[f])
    );
    res.status(201).json({ success: true, message: 'Currency created.', currency_id: result.insertId, version: 1 });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: `Currency ${data.currency_code} already exists.` });
    }
    sendServerError(res, 'Failed to create currency', error);
  }
};

// PUT /api/currencies/:id — must carry the version it was loaded with (409 if changed meanwhile)
exports.updateCurrency = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return sendInvalidId(res);

  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) {
    return res.status(400).json({ success: false, message: 'Missing currency version. Reload and try again.' });
  }
  const { data, errors } = normalizeCurrency(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  try {
    const [result] = await db.execute(
      `UPDATE currencies SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, version = version + 1
       WHERE currency_id = ? AND version = ?`,
      [...FIELDS.map((f) => data[f]), id, version]
    );
    if (result.affectedRows === 0) {
      const [existing] = await db.query('SELECT version FROM currencies WHERE currency_id = ?', [id]);
      if (existing.length === 0) return res.status(404).json({ success: false, message: 'Currency not found' });
      return res.status(409).json({ success: false, message: 'This currency was changed somewhere else. Reload and try again.' });
    }
    res.status(200).json({ success: true, message: 'Currency updated.', version: version + 1 });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: `Currency ${data.currency_code} already exists.` });
    }
    sendServerError(res, 'Failed to update currency', error);
  }
};
