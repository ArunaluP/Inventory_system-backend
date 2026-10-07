-- 004: Additional costs per template + version numbers for edit-conflict detection.
-- Run once, after 001–003. Safe on both:
--   * a database where template_additional_costs was already created from the plan SQL
--     (it upgrades that table in place and keeps its rows), and
--   * a fresh database (it creates the table and moves existing commissions into it).
-- Nothing is deleted.

-- 1) Table (skipped if it already exists)
CREATE TABLE IF NOT EXISTS template_additional_costs (
  cost_id      INT AUTO_INCREMENT PRIMARY KEY,
  template_id  INT NOT NULL,
  cost_name    VARCHAR(150) NOT NULL,
  percentage   DECIMAL(7,4) NOT NULL DEFAULT 0,
  amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 1,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_additional_costs_template
    FOREIGN KEY (template_id) REFERENCES templates(template_id) ON DELETE CASCADE,
  CONSTRAINT chk_additional_costs_name CHECK (CHAR_LENGTH(TRIM(cost_name)) > 0),
  CONSTRAINT chk_additional_costs_percentage CHECK (percentage >= 0 AND percentage <= 100),
  INDEX idx_additional_costs_template (template_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2) Move existing sales commissions in — only for templates that don't have costs yet,
--    so running this after the plan SQL doesn't duplicate rows.
INSERT INTO template_additional_costs (template_id, cost_name, percentage, amount, sort_order)
SELECT t.template_id, 'Sales Commission', t.sales_commission_percentage,
       ROUND(COALESCE(x.subtotal, 0) * t.sales_commission_percentage / 100, 2), 1
FROM templates t
LEFT JOIN (
  SELECT s.template_id, SUM(i.total_amount) AS subtotal
  FROM template_sections s
  JOIN template_items i ON i.section_id = s.section_id
  GROUP BY s.template_id
) x ON x.template_id = t.template_id
WHERE t.sales_commission_percentage <> 0
  AND NOT EXISTS (SELECT 1 FROM template_additional_costs c WHERE c.template_id = t.template_id);

-- 3) Upgrade to the final shape:
--    calc_mode  = which value the user typed ('percent' or 'amount'); the other is derived.
--    percentage = wider, so a % derived from a fixed amount fits.
--    The old 0..100 check is replaced: negative values (deductions) are allowed, and a typed
--    % must be within -100..100; a derived % (amount mode) is not limited.
ALTER TABLE template_additional_costs DROP CHECK chk_additional_costs_percentage;
ALTER TABLE template_additional_costs
  ADD COLUMN calc_mode ENUM('percent', 'amount') NOT NULL DEFAULT 'percent' AFTER cost_name,
  MODIFY COLUMN percentage DECIMAL(12,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_additional_costs_percentage CHECK (calc_mode <> 'percent' OR percentage BETWEEN -100 AND 100);

-- 4) Version numbers: every save increments it; a save carrying an older version is rejected,
--    so two open copies can't silently overwrite each other.
ALTER TABLE templates ADD COLUMN version INT NOT NULL DEFAULT 1;
ALTER TABLE materials ADD COLUMN version INT NOT NULL DEFAULT 1;

-- templates.sales_commission_percentage is kept as a backup but no longer used by the app.
-- Once you're happy with the migration you can drop it:
--   ALTER TABLE templates DROP COLUMN sales_commission_percentage;
