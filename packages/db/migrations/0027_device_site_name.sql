-- Adds a "yerleşke" (site / campus) level above the building (project_name) so the customer
-- hierarchy can be: customer → site → building → unit-type. Optional, free-text like project_name.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS site_name TEXT NULL;

COMMENT ON COLUMN devices.site_name IS
  'Yerleşke/kampüs adı (binanın üstü). Hiyerarşi: musteri > yerleske (site_name) > bina (project_name) > birim (property_type).';

CREATE INDEX IF NOT EXISTS idx_devices_site_name ON devices (site_name);
