-- 008: Suppliers can now be added / edited in the app (Suppliers tab) and from the Excel import.
--  * version: edit-conflict protection (same as templates, items, currencies)
--  * status defaults to Active
--  * materials.supplier_id now references supplier_details (it was only checked by the app)
-- Run once, after 007. Use "Execute All" (Ctrl+Shift+Enter) in MySQL Workbench / phpMyAdmin SQL tab.
-- Nothing is deleted. Fails safely (step 3) if an item points at a supplier that doesn't exist.

-- 1) Version column for safe editing
ALTER TABLE supplier_details ADD COLUMN version INT NOT NULL DEFAULT 1;

-- 2) New suppliers are Active unless set otherwise
ALTER TABLE supplier_details MODIFY COLUMN status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active';

-- 3) Items may only reference existing suppliers
ALTER TABLE materials
  ADD CONSTRAINT fk_materials_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_details(supplier_id);
