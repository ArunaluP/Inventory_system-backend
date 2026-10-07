-- BOQ layout: currency, spec summary lines, and the sheet's pricing model
-- (sales commission, gross profit, risk markup, manually quoted final prices).
-- discount_percentage / tax_percentage are kept for old rows but no longer used.
ALTER TABLE templates
  ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'MMK' AFTER description,
  ADD COLUMN spec_panels VARCHAR(500) NULL AFTER currency,
  ADD COLUMN spec_inverter VARCHAR(500) NULL AFTER spec_panels,
  ADD COLUMN spec_battery VARCHAR(500) NULL AFTER spec_inverter,
  ADD COLUMN spec_other VARCHAR(500) NULL AFTER spec_battery,
  ADD COLUMN sales_commission_percentage DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER tax_percentage,
  ADD COLUMN gross_profit_percentage DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER sales_commission_percentage,
  ADD COLUMN risk_markup_percentage DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER gross_profit_percentage,
  ADD COLUMN solution_price_override DECIMAL(14,2) NULL AFTER risk_markup_percentage,
  ADD COLUMN cash_price_override DECIMAL(14,2) NULL AFTER solution_price_override,
  ADD COLUMN cash_price DECIMAL(14,2) NULL AFTER grand_total,
  MODIFY COLUMN grand_total DECIMAL(14,2);
