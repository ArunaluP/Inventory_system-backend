// Validation for currency rows (Currencies tab and the Excel "Currencies" sheet).

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

const normalizeCurrency = (body) => {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  const code = String(b.currency_code ?? '').trim().toUpperCase();
  const name = String(b.currency_name ?? '').trim();
  const symbol = String(b.symbol ?? '').trim();
  const country = String(b.country ?? '').trim();
  const decimals = isBlank(b.decimal_places) ? 2 : Number(b.decimal_places);

  if (!/^[A-Z]{2,10}$/.test(code)) errors.push('Code must be 2–10 letters (e.g. LKR, USD).');
  if (!name) errors.push('Name is required.');
  if (name.length > 100) errors.push('Name must be at most 100 characters.');
  if (symbol.length > 10) errors.push('Symbol must be at most 10 characters.');
  if (country.length > 100) errors.push('Country must be at most 100 characters.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 2) errors.push('Decimal places must be 0, 1 or 2.');

  return {
    errors,
    data: {
      currency_code: code,
      currency_name: name,
      symbol: symbol || null,
      decimal_places: Number.isInteger(decimals) ? decimals : 2,
      country: country || null,
      is_active: b.is_active === undefined ? 1 : (b.is_active ? 1 : 0)
    }
  };
};

const FIELDS = ['currency_code', 'currency_name', 'symbol', 'decimal_places', 'country', 'is_active'];

module.exports = { FIELDS, normalizeCurrency };
