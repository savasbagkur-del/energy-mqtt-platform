CREATE TABLE IF NOT EXISTS devices (
  sn TEXT PRIMARY KEY,
  product_key TEXT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_method TEXT NULL,
  devname TEXT NULL,
  softcode TEXT NULL,
  softversion TEXT NULL,
  network JSONB NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_product_key ON devices (product_key);

CREATE TABLE IF NOT EXISTS latest_state (
  sn TEXT PRIMARY KEY REFERENCES devices (sn) ON DELETE CASCADE,
  product_key TEXT NULL,
  last_method TEXT NULL,
  last_msgid TEXT NULL,
  last_timestamp TIMESTAMPTZ NULL,
  last_topic TEXT NOT NULL,
  last_payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_latest_state_updated_at ON latest_state (updated_at DESC);
