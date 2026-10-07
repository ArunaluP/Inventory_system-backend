// Validation for supplier rows (Suppliers tab and the Excel "Suppliers" sheet).
// Limits match the supplier_details columns.
const { parseId, isTextLike } = require('./parse');

const TEXT_FIELDS = {
  company_name: { label: 'Company name', max: 150, required: true },
  contact_person: { label: 'Contact person', max: 100 },
  email: { label: 'Email', max: 100 },
  phone: { label: 'Phone', max: 30 },
  address_line_1: { label: 'Address line 1', max: 150 },
  address_line_2: { label: 'Address line 2', max: 150 },
  city: { label: 'City', max: 50 },
  country: { label: 'Country', max: 50 },
  tax_id_number: { label: 'Tax ID', max: 50 },
  payment_terms: { label: 'Payment terms', max: 50 }
};
const SUPPLIER_FIELDS = [...Object.keys(TEXT_FIELDS), 'lead_time_days', 'status'];

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

// Returns { data, errors }; data holds every SUPPLIER_FIELDS column, cleaned
const normalizeSupplier = (input) => {
  const b = input && typeof input === 'object' ? input : {};
  const data = {};
  const errors = [];

  for (const [field, rule] of Object.entries(TEXT_FIELDS)) {
    const raw = b[field];
    if (!isBlank(raw) && !isTextLike(raw)) {
      errors.push(`${rule.label} must be text`);
      data[field] = null;
      continue;
    }
    const str = isBlank(raw) ? '' : String(raw).trim();
    if (rule.required && !str) errors.push(`${rule.label} is required`);
    if (str.length > rule.max) errors.push(`${rule.label} must be at most ${rule.max} characters`);
    data[field] = str || null;
  }
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('Email is not a valid address');

  if (isBlank(b.lead_time_days)) {
    data.lead_time_days = null;
  } else {
    const days = b.lead_time_days === 0 || b.lead_time_days === '0' ? 0 : parseId(b.lead_time_days);
    if (days === null || days > 3650) errors.push('Lead time must be a whole number of days (0–3650)');
    data.lead_time_days = days ?? null;
  }

  const status = isBlank(b.status) ? 'active' : String(b.status).trim().toLowerCase();
  if (!['active', 'inactive'].includes(status)) errors.push('Status must be Active or Inactive');
  data.status = status === 'inactive' ? 'Inactive' : 'Active';

  return { data, errors };
};

module.exports = { SUPPLIER_FIELDS, normalizeSupplier };
