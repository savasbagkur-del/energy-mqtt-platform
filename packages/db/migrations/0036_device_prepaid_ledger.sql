-- Prepaid ledger: platform top-ups, consumption from meter EPI, auto-cutoff settings.

CREATE TABLE IF NOT EXISTS device_prepaid_settings (
  sn TEXT PRIMARY KEY REFERENCES devices (sn) ON DELETE CASCADE,
  baseline_epi_kwh NUMERIC NOT NULL DEFAULT 0,
  cutoff_balance_kwh NUMERIC NOT NULL DEFAULT 0,
  auto_cutoff_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prepaid_topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sn TEXT NOT NULL REFERENCES devices (sn) ON DELETE CASCADE,
  customer_id BIGINT NULL REFERENCES customers (id) ON DELETE SET NULL,
  amount_kwh NUMERIC NOT NULL CHECK (amount_kwh > 0),
  amount_money NUMERIC NULL,
  source TEXT NOT NULL CHECK (source IN ('panel', 'api', 'import')),
  ref TEXT NULL,
  note TEXT NULL,
  created_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prepaid_topups_sn_created
  ON prepaid_topups (sn, created_at DESC);
