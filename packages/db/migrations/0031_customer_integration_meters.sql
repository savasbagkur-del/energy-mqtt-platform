-- Customer integration mode + device unit/usage metadata for onboarding.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS integration_mode TEXT NOT NULL DEFAULT 'panel';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_integration_mode_chk') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_integration_mode_chk
      CHECK (integration_mode IN ('panel', 'api'));
  END IF;
END $$;

UPDATE customers SET integration_mode = 'api' WHERE panel_enabled = FALSE;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS unit_no TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS meter_usage TEXT NOT NULL DEFAULT 'prepaid';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_meter_usage_chk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_meter_usage_chk
      CHECK (meter_usage IN ('prepaid', 'postpaid'));
  END IF;
END $$;
