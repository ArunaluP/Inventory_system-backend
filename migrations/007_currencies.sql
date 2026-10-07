-- 007: Currencies as saved records; every item and every template has a currency.
--  * currencies: code, name, symbol, decimal places (display only, 0-2), country, active flag
--  * materials.currency_id (required). Material ID becomes unique PER CURRENCY, so the same item
--    can exist once per currency with the same Material ID + Item Code (that pair is how a
--    template's lines are matched when its currency changes).
--  * templates.currency_id (required). templates.currency (code text) is kept and filled too.
-- Existing items get MMK as a placeholder (change them in Items afterwards).
-- Run once, after 006. Use "Execute All" (Ctrl+Shift+Enter) in MySQL Workbench.

-- 1) Currencies
CREATE TABLE currencies (
  currency_id     INT AUTO_INCREMENT PRIMARY KEY,
  currency_code   VARCHAR(10)  NOT NULL,
  currency_name   VARCHAR(100) NOT NULL,
  symbol          VARCHAR(10)  NULL,
  decimal_places  TINYINT      NOT NULL DEFAULT 2,
  country         VARCHAR(100) NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  version         INT          NOT NULL DEFAULT 1,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_currencies_code UNIQUE (currency_code),
  CONSTRAINT chk_currencies_code CHECK (currency_code REGEXP '^[A-Z]{2,10}$'),
  CONSTRAINT chk_currencies_name CHECK (CHAR_LENGTH(TRIM(currency_name)) BETWEEN 1 AND 100),
  CONSTRAINT chk_currencies_decimals CHECK (decimal_places BETWEEN 0 AND 2)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2) The currencies already used by templates (MMK, LKR), plus any other code found
INSERT INTO currencies (currency_code, currency_name, symbol, decimal_places, country) VALUES
  ('MMK', 'Myanmar Kyat', 'K', 2, 'Myanmar'),
  ('LKR', 'Sri Lankan Rupee', 'Rs', 2, 'Sri Lanka');
INSERT IGNORE INTO currencies (currency_code, currency_name)
SELECT DISTINCT UPPER(TRIM(currency)), UPPER(TRIM(currency))
FROM templates
WHERE currency IS NOT NULL AND UPPER(TRIM(currency)) REGEXP '^[A-Z]{2,10}$';

-- 3) Items: currency (MMK placeholder for existing rows), Material ID unique per currency
ALTER TABLE materials ADD COLUMN currency_id INT NULL AFTER material_id;
UPDATE materials SET currency_id = (SELECT currency_id FROM currencies WHERE currency_code = 'MMK');
ALTER TABLE materials
  MODIFY COLUMN currency_id INT NOT NULL,
  DROP INDEX material_id,
  ADD CONSTRAINT uq_materials_material_currency UNIQUE (material_id, currency_id),
  ADD CONSTRAINT fk_materials_currency FOREIGN KEY (currency_id) REFERENCES currencies(currency_id);

-- 4) Templates: currency_id from the existing currency code (anything unmatched -> MMK)
ALTER TABLE templates ADD COLUMN currency_id INT NULL AFTER currency;
UPDATE templates t JOIN currencies c ON c.currency_code = UPPER(TRIM(t.currency)) SET t.currency_id = c.currency_id;
UPDATE templates SET currency_id = (SELECT currency_id FROM currencies WHERE currency_code = 'MMK') WHERE currency_id IS NULL;
ALTER TABLE templates
  MODIFY COLUMN currency_id INT NOT NULL,
  ADD CONSTRAINT fk_templates_currency FOREIGN KEY (currency_id) REFERENCES currencies(currency_id);
