const db = require('../config/db');
const { sendServerError, parseId, sendInvalidId } = require('../utils/http');
const { SUPPLIER_FIELDS, normalizeSupplier } = require('../utils/supplierValidation');

// Suppliers are never deleted (items reference them); set status Inactive to retire one.

// GET /api/suppliers — all suppliers with how many items use each
exports.getAllSuppliers = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT s.*, (SELECT COUNT(*) FROM materials m WHERE m.supplier_id = s.supplier_id) AS item_count
      FROM supplier_details s
      ORDER BY s.status ASC, s.supplier_id ASC
    `);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    sendServerError(res, 'Failed to fetch suppliers', error);
  }
};

// POST /api/suppliers — the database assigns the next ID
exports.createSupplier = async (req, res) => {
  const { data, errors } = normalizeSupplier(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  try {
    const [result] = await db.execute(
      `INSERT INTO supplier_details (${SUPPLIER_FIELDS.join(', ')}, version) VALUES (${SUPPLIER_FIELDS.map(() => '?').join(', ')}, 1)`,
      SUPPLIER_FIELDS.map((f) => data[f])
    );
    res.status(201).json({ success: true, message: 'Supplier created.', supplier_id: result.insertId, version: 1 });
  } catch (error) {
    sendServerError(res, 'Failed to create supplier', error);
  }
};

// PUT /api/suppliers/:id — must carry the version it was loaded with (409 if changed meanwhile)
exports.updateSupplier = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return sendInvalidId(res);

  const version = parseId(req.body?.version);
  if (!version) return res.status(400).json({ success: false, message: 'Missing supplier version. Reload and try again.' });
  const { data, errors } = normalizeSupplier(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

  try {
    const [result] = await db.execute(
      `UPDATE supplier_details SET ${SUPPLIER_FIELDS.map((f) => `${f} = ?`).join(', ')}, version = version + 1
       WHERE supplier_id = ? AND version = ?`,
      [...SUPPLIER_FIELDS.map((f) => data[f]), id, version]
    );
    if (result.affectedRows === 0) {
      const [existing] = await db.query('SELECT version FROM supplier_details WHERE supplier_id = ?', [id]);
      if (existing.length === 0) return res.status(404).json({ success: false, message: 'Supplier not found' });
      return res.status(409).json({ success: false, message: 'This supplier was changed somewhere else. Reload and try again.' });
    }
    res.status(200).json({ success: true, message: 'Supplier updated.', version: version + 1 });
  } catch (error) {
    sendServerError(res, 'Failed to update supplier', error);
  }
};
