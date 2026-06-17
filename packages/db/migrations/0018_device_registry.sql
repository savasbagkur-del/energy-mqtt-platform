-- Device registry: customers, property types, and business metadata + lifecycle/whitelist on devices.
-- public.devices remains the operational SN-keyed table; we enrich it rather than bridge to the
-- unused domain.devices. Pre-registration is now possible (last_seen_at may be NULL until first contact).

-- Property types are a seeded lookup so operators can extend the list (ev/daire/yurt/dukkan/...).
CREATE TABLE IF NOT EXISTS property_types (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO property_types (code, label, sort_order) VALUES
  ('ev', 'Ev', 10),
  ('daire', 'Daire', 20),
  ('yurt', 'Yurt', 30),
  ('dukkan', 'Dükkan', 40),
  ('ofis', 'Ofis', 50),
  ('fabrika', 'Fabrika / Sanayi', 60),
  ('diger', 'Diğer', 100)
ON CONFLICT (code) DO NOTHING;

-- Customers / subscribers.
CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NULL,
  email TEXT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name);

-- Allow pre-registration before a device ever connects.
ALTER TABLE devices ALTER COLUMN last_seen_at DROP NOT NULL;

-- Business metadata.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS customer_id BIGINT NULL REFERENCES customers (id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS subscriber_no TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS label TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS property_type_id INT NULL REFERENCES property_types (id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS address_line TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS district TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS city TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS tariff TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS region TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS dealer TEXT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS install_date DATE NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS notes TEXT NULL;

-- Registry / lifecycle.
--   registry_status: 'registered' (whitelisted, managed), 'auto' (legacy auto-registered, managed),
--                    'quarantined' (unknown SN seen while whitelist is on; visible but NOT managed).
--   lifecycle_status: 'registered' -> 'commissioned' (first contact) -> 'active' -> 'decommissioned'.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS registry_status TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS commissioned_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_registry_status_chk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_registry_status_chk
      CHECK (registry_status IN ('registered', 'auto', 'quarantined'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_lifecycle_status_chk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_lifecycle_status_chk
      CHECK (lifecycle_status IN ('registered', 'commissioned', 'active', 'decommissioned', 'unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_devices_registry_status ON devices (registry_status);
CREATE INDEX IF NOT EXISTS idx_devices_customer_id ON devices (customer_id);
CREATE INDEX IF NOT EXISTS idx_devices_subscriber_no ON devices (subscriber_no);
