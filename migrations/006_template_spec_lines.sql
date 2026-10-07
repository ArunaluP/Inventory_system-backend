-- 006: Customizable spec lines in the document header (replaces the fixed
-- Panels / Inverter / Battery / Other fields). One row per line: a title and its details,
-- in the user's order. A row with a title but no details is kept (so the title is reused)
-- but not shown in View / Print / PDF / Excel.
-- templates.spec_panels / spec_inverter / spec_battery / spec_other are kept but no longer
-- used (all empty on 2026-10-05, so nothing is moved).

CREATE TABLE template_spec_lines (
  spec_line_id  INT AUTO_INCREMENT PRIMARY KEY,
  template_id   INT NOT NULL,
  line_title    VARCHAR(100) NOT NULL,
  line_details  VARCHAR(500) NULL,
  sort_order    INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_spec_lines_template
    FOREIGN KEY (template_id) REFERENCES templates(template_id) ON DELETE CASCADE,
  CONSTRAINT chk_spec_lines_title CHECK (CHAR_LENGTH(TRIM(line_title)) BETWEEN 1 AND 100),
  INDEX idx_spec_lines_template (template_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
