-- Store the brand on each template line item so it survives save / reopen.
ALTER TABLE template_items ADD COLUMN brand VARCHAR(100) NULL AFTER product_name;
