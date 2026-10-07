-- 004c: the two steps of 004b that are still missing (checked 2026-10-02).
-- templates.version already exists, so do NOT re-run 004b. Run these two statements once,
-- in order, then run 005_additional_section_2.sql.

-- 1) Remove the old 0..100 check (it blocks negative values / deductions)
ALTER TABLE template_additional_costs DROP CHECK chk_additional_costs_percentage;

-- 2) Add calc_mode (existing rows become 'percent'), widen percentage, and add the new rule:
--    a typed % must be -100..100, a % derived from a fixed amount is not limited
ALTER TABLE template_additional_costs
  ADD COLUMN calc_mode ENUM('percent', 'amount') NOT NULL DEFAULT 'percent' AFTER cost_name,
  MODIFY COLUMN percentage DECIMAL(12,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_additional_costs_percentage CHECK (calc_mode <> 'percent' OR percentage BETWEEN -100 AND 100);
