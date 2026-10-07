-- 005: "Additional Section 2" — user-defined rows applied after Total Cost, compounding:
--   running₀ = Total Cost
--   row amount = running × % / 100   (percent mode)   or a typed fixed amount (amount mode)
--   running   = running + row amount
--   Solution Price = running after the last row
-- Cash Price compounds only the rows ticked "In cash price", in the same order, from Total Cost.
-- Replaces the fixed Gross profit % / Risk markup % lines (their columns on `templates` are kept
-- but no longer used). Existing templates are not converted. Run after 004b.

CREATE TABLE template_section2_additions (
  addition_id            INT AUTO_INCREMENT PRIMARY KEY,
  template_id            INT NOT NULL,
  addition_name          VARCHAR(150) NOT NULL,
  calc_mode              ENUM('percent', 'amount') NOT NULL DEFAULT 'percent',
  percentage             DECIMAL(12,4) NOT NULL DEFAULT 0,  -- typed (percent mode) or derived from the amount
  base_amount            DECIMAL(14,2) NOT NULL DEFAULT 0,  -- running total this row was applied to
  amount                 DECIMAL(14,2) NOT NULL DEFAULT 0,  -- amount in the Solution Price chain (server-calculated)
  include_in_cash_price  TINYINT(1) NOT NULL DEFAULT 1,
  cash_amount            DECIMAL(14,2) NULL,                -- amount in the Cash Price chain, NULL when not ticked
  sort_order             INT NOT NULL DEFAULT 1,
  created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_section2_additions_template
    FOREIGN KEY (template_id) REFERENCES templates(template_id) ON DELETE CASCADE,
  CONSTRAINT chk_section2_additions_name CHECK (CHAR_LENGTH(TRIM(addition_name)) BETWEEN 1 AND 150),
  -- A typed % must be within -99.99..1000 (-100 would zero the price), a derived % is not limited
  CONSTRAINT chk_section2_additions_percentage CHECK (calc_mode <> 'percent' OR percentage BETWEEN -99.99 AND 1000),
  INDEX idx_section2_additions_template (template_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
