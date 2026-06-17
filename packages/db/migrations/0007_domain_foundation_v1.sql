CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS domain;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'account_type_enum' AND n.nspname = 'domain') THEN
    CREATE TYPE domain.account_type_enum AS ENUM ('person', 'company', 'management');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'property_type_enum' AND n.nspname = 'domain') THEN
    CREATE TYPE domain.property_type_enum AS ENUM ('villa', 'apartman', 'site', 'yurt');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'unit_type_enum' AND n.nspname = 'domain') THEN
    CREATE TYPE domain.unit_type_enum AS ENUM ('daire', 'oda', 'studyo', 'camasirhane', 'ortak_alan', 'ofis', 'depo', 'diger');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'contact_role_enum' AND n.nspname = 'domain') THEN
    CREATE TYPE domain.contact_role_enum AS ENUM ('primary_account_contact', 'building_manager', 'technical_contact', 'owner_contact', 'tenant_contact', 'billing_contact', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'occupancy_type_enum' AND n.nspname = 'domain') THEN
    CREATE TYPE domain.occupancy_type_enum AS ENUM ('owner', 'tenant', 'manager', 'vacant');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'device_type_enum' AND n.nspname = 'domain') THEN
    CREATE TYPE domain.device_type_enum AS ENUM ('meter', 'router');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'record_status_enum' AND n.nspname = 'domain') THEN
    CREATE TYPE domain.record_status_enum AS ENUM ('active', 'inactive', 'archived');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION domain.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS domain.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type domain.account_type_enum NOT NULL,
  legal_name TEXT NOT NULL,
  display_name TEXT NULL,
  registration_no TEXT NULL,
  tax_no TEXT NULL,
  address_text TEXT NULL,
  notes TEXT NULL,
  status domain.record_status_enum NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_accounts_account_type ON domain.accounts (account_type);
CREATE INDEX IF NOT EXISTS idx_domain_accounts_status ON domain.accounts (status);

CREATE TABLE IF NOT EXISTS domain.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES domain.accounts (id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role_type domain.contact_role_enum NOT NULL,
  mobile_phone TEXT NULL,
  landline_phone TEXT NULL,
  email TEXT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NULL,
  status domain.record_status_enum NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_contacts_account_id ON domain.contacts (account_id);
CREATE INDEX IF NOT EXISTS idx_domain_contacts_role_type ON domain.contacts (role_type);
CREATE INDEX IF NOT EXISTS idx_domain_contacts_status ON domain.contacts (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_contacts_account_single_primary
  ON domain.contacts (account_id)
  WHERE is_primary = TRUE;

CREATE TABLE IF NOT EXISTS domain.properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES domain.accounts (id) ON DELETE RESTRICT,
  property_type domain.property_type_enum NOT NULL,
  name TEXT NOT NULL,
  address_text TEXT NULL,
  latitude DOUBLE PRECISION NULL,
  longitude DOUBLE PRECISION NULL,
  total_unit_count INTEGER NULL,
  manager_contact_id UUID NULL REFERENCES domain.contacts (id) ON DELETE SET NULL,
  notes TEXT NULL,
  status domain.record_status_enum NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_domain_properties_total_unit_count_nonnegative
    CHECK (total_unit_count IS NULL OR total_unit_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_domain_properties_account_id ON domain.properties (account_id);
CREATE INDEX IF NOT EXISTS idx_domain_properties_manager_contact_id ON domain.properties (manager_contact_id);
CREATE INDEX IF NOT EXISTS idx_domain_properties_status ON domain.properties (status);

CREATE TABLE IF NOT EXISTS domain.units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES domain.properties (id) ON DELETE CASCADE,
  unit_type domain.unit_type_enum NOT NULL,
  unit_code TEXT NOT NULL,
  unit_name TEXT NULL,
  floor_no INTEGER NULL,
  description TEXT NULL,
  notes TEXT NULL,
  status domain.record_status_enum NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_units_property_id ON domain.units (property_id);
CREATE INDEX IF NOT EXISTS idx_domain_units_status ON domain.units (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_units_property_unit_code_unique
  ON domain.units (property_id, unit_code);

CREATE TABLE IF NOT EXISTS domain.occupancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id UUID NOT NULL REFERENCES domain.units (id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES domain.contacts (id) ON DELETE RESTRICT,
  occupancy_type domain.occupancy_type_enum NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_domain_occupancies_dates
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_domain_occupancies_unit_id ON domain.occupancies (unit_id);
CREATE INDEX IF NOT EXISTS idx_domain_occupancies_contact_id ON domain.occupancies (contact_id);
CREATE INDEX IF NOT EXISTS idx_domain_occupancies_is_current ON domain.occupancies (is_current);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_occupancies_single_current_per_unit
  ON domain.occupancies (unit_id)
  WHERE is_current = TRUE;

CREATE TABLE IF NOT EXISTS domain.devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_type domain.device_type_enum NOT NULL,
  serial_no TEXT NULL,
  manufacturer TEXT NULL,
  model TEXT NULL,
  firmware_version TEXT NULL,
  mac_address TEXT NULL,
  mqtt_sn TEXT NULL,
  mqtt_product_key TEXT NULL,
  notes TEXT NULL,
  status domain.record_status_enum NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_devices_serial_no_unique
  ON domain.devices (serial_no)
  WHERE serial_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_devices_mac_address_unique
  ON domain.devices (mac_address)
  WHERE mac_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_domain_devices_device_type ON domain.devices (device_type);
CREATE INDEX IF NOT EXISTS idx_domain_devices_status ON domain.devices (status);

CREATE TABLE IF NOT EXISTS domain.device_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES domain.devices (id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES domain.properties (id) ON DELETE CASCADE,
  unit_id UUID NULL REFERENCES domain.units (id) ON DELETE SET NULL,
  router_device_id UUID NULL REFERENCES domain.devices (id) ON DELETE SET NULL,
  floor_no INTEGER NULL,
  location_note TEXT NULL,
  signal_zone TEXT NULL,
  initial_kwh NUMERIC(14, 3) NULL,
  installed_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_domain_device_installations_dates
    CHECK (removed_at IS NULL OR removed_at >= installed_at),
  CONSTRAINT chk_domain_device_installations_initial_kwh_nonnegative
    CHECK (initial_kwh IS NULL OR initial_kwh >= 0)
);

CREATE INDEX IF NOT EXISTS idx_domain_device_installations_device_id
  ON domain.device_installations (device_id);
CREATE INDEX IF NOT EXISTS idx_domain_device_installations_property_id
  ON domain.device_installations (property_id);
CREATE INDEX IF NOT EXISTS idx_domain_device_installations_unit_id
  ON domain.device_installations (unit_id);
CREATE INDEX IF NOT EXISTS idx_domain_device_installations_router_device_id
  ON domain.device_installations (router_device_id);
CREATE INDEX IF NOT EXISTS idx_domain_device_installations_is_active
  ON domain.device_installations (is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_device_installations_single_active_per_device
  ON domain.device_installations (device_id)
  WHERE is_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_device_installations_single_active_per_unit
  ON domain.device_installations (unit_id)
  WHERE unit_id IS NOT NULL AND is_active = TRUE;

CREATE OR REPLACE FUNCTION domain.validate_device_installation()
RETURNS TRIGGER AS $$
DECLARE
  v_device_type domain.device_type_enum;
  v_router_device_type domain.device_type_enum;
  v_unit_property_id UUID;
BEGIN
  SELECT d.device_type INTO v_device_type
  FROM domain.devices d
  WHERE d.id = NEW.device_id;

  IF v_device_type IS NULL THEN
    RAISE EXCEPTION 'device % not found in domain.devices', NEW.device_id;
  END IF;

  IF NEW.unit_id IS NOT NULL THEN
    SELECT u.property_id INTO v_unit_property_id
    FROM domain.units u
    WHERE u.id = NEW.unit_id;

    IF v_unit_property_id IS NULL THEN
      RAISE EXCEPTION 'unit % not found in domain.units', NEW.unit_id;
    END IF;

    IF v_unit_property_id <> NEW.property_id THEN
      RAISE EXCEPTION 'unit % does not belong to property %', NEW.unit_id, NEW.property_id;
    END IF;
  END IF;

  IF v_device_type = 'meter' AND NEW.unit_id IS NULL THEN
    RAISE EXCEPTION 'meter installations require unit_id in V1';
  END IF;

  IF v_device_type = 'router' AND NEW.unit_id IS NOT NULL THEN
    RAISE EXCEPTION 'router installations must be property-level (unit_id must be NULL)';
  END IF;

  IF NEW.router_device_id IS NOT NULL THEN
    SELECT d.device_type INTO v_router_device_type
    FROM domain.devices d
    WHERE d.id = NEW.router_device_id;

    IF v_router_device_type IS NULL THEN
      RAISE EXCEPTION 'router device % not found in domain.devices', NEW.router_device_id;
    END IF;

    IF v_router_device_type <> 'router' THEN
      RAISE EXCEPTION 'router_device_id % must point to a router device', NEW.router_device_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_domain_device_installations_validate ON domain.device_installations;
CREATE TRIGGER trg_domain_device_installations_validate
  BEFORE INSERT OR UPDATE ON domain.device_installations
  FOR EACH ROW
  EXECUTE FUNCTION domain.validate_device_installation();

DROP TRIGGER IF EXISTS trg_domain_accounts_touch_updated_at ON domain.accounts;
CREATE TRIGGER trg_domain_accounts_touch_updated_at
  BEFORE UPDATE ON domain.accounts
  FOR EACH ROW
  EXECUTE FUNCTION domain.touch_updated_at();

DROP TRIGGER IF EXISTS trg_domain_contacts_touch_updated_at ON domain.contacts;
CREATE TRIGGER trg_domain_contacts_touch_updated_at
  BEFORE UPDATE ON domain.contacts
  FOR EACH ROW
  EXECUTE FUNCTION domain.touch_updated_at();

DROP TRIGGER IF EXISTS trg_domain_properties_touch_updated_at ON domain.properties;
CREATE TRIGGER trg_domain_properties_touch_updated_at
  BEFORE UPDATE ON domain.properties
  FOR EACH ROW
  EXECUTE FUNCTION domain.touch_updated_at();

DROP TRIGGER IF EXISTS trg_domain_units_touch_updated_at ON domain.units;
CREATE TRIGGER trg_domain_units_touch_updated_at
  BEFORE UPDATE ON domain.units
  FOR EACH ROW
  EXECUTE FUNCTION domain.touch_updated_at();

DROP TRIGGER IF EXISTS trg_domain_occupancies_touch_updated_at ON domain.occupancies;
CREATE TRIGGER trg_domain_occupancies_touch_updated_at
  BEFORE UPDATE ON domain.occupancies
  FOR EACH ROW
  EXECUTE FUNCTION domain.touch_updated_at();

DROP TRIGGER IF EXISTS trg_domain_devices_touch_updated_at ON domain.devices;
CREATE TRIGGER trg_domain_devices_touch_updated_at
  BEFORE UPDATE ON domain.devices
  FOR EACH ROW
  EXECUTE FUNCTION domain.touch_updated_at();

DROP TRIGGER IF EXISTS trg_domain_device_installations_touch_updated_at ON domain.device_installations;
CREATE TRIGGER trg_domain_device_installations_touch_updated_at
  BEFORE UPDATE ON domain.device_installations
  FOR EACH ROW
  EXECUTE FUNCTION domain.touch_updated_at();
