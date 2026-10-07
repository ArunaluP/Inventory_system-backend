-- 004b: finishes migration 004 on a database where it was only partly applied.
-- Checked 2026-10-02: template_additional_costs exists with its data and materials.version
-- exists, but calc_mode, the new percentage check and templates.version are missing.
-- Run these three statements once, in order. Nothing is deleted.

-- 1) Replace the old 0..100 check (blocks negative costs) …
ALTER TABLE template_additional_costs DROP CHECK chk_additional_costs_percentage;

-- 2) … add calc_mode, widen percentage, and add the new rule: a typed % must be -100..100,
--    a % derived from a fixed amount is not limited. Existing rows become 'percent'.
ALTER TABLE template_additional_costs
  ADD COLUMN calc_mode ENUM('percent', 'amount') NOT NULL DEFAULT 'percent' AFTER cost_name,
  MODIFY COLUMN percentage DECIMAL(12,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_additional_costs_percentage CHECK (calc_mode <> 'percent' OR percentage BETWEEN -100 AND 100);

-- 3) Version number for template edit-conflict protection
ALTER TABLE templates ADD COLUMN version INT NOT NULL DEFAULT 1;
