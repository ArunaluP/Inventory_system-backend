-- Guidance comment per line item (e.g. "620W Bi-facial panel, Jinko or Longi").
-- Shown as the placeholder / hover hint when the line's item is empty, and in the Excel export.
ALTER TABLE template_items ADD COLUMN comment VARCHAR(500) NULL;
