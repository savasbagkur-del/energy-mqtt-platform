CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS telemetry_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sn TEXT NOT NULL,
  product_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  method TEXT NOT NULL,
  msgid TEXT NULL,
  payload_json JSONB NOT NULL,
  parse_status TEXT NOT NULL,
  device_sample_at TIMESTAMPTZ NULL,
  device_sent_at TIMESTAMPTZ NULL,
  worker_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingest_lag_ms INTEGER NULL,
  device_report_lag_sec INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_raw_sn_created_at
  ON telemetry_raw (sn, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_raw_method
  ON telemetry_raw (method);
CREATE INDEX IF NOT EXISTS idx_telemetry_raw_topic
  ON telemetry_raw (topic);

CREATE TABLE IF NOT EXISTS telemetry_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sn TEXT NOT NULL,
  product_key TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NULL,
  voltage_v NUMERIC NULL,
  current_a NUMERIC NULL,
  active_power_kw NUMERIC NULL,
  reactive_power_kvar NUMERIC NULL,
  power_factor NUMERIC NULL,
  energy_import_kwh NUMERIC NULL,
  balance NUMERIC NULL,
  switch_state INTEGER NULL,
  rssi INTEGER NULL,
  channel INTEGER NULL,
  mac_address TEXT NULL,
  raw_id UUID NOT NULL REFERENCES telemetry_raw (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_samples_sn_observed_at
  ON telemetry_samples (sn, observed_at DESC);

CREATE TABLE IF NOT EXISTS device_latest_state (
  sn TEXT PRIMARY KEY,
  product_key TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_method TEXT NOT NULL,
  last_msgid TEXT NULL,
  last_topic TEXT NOT NULL,
  source TEXT NULL,
  voltage_v NUMERIC NULL,
  current_a NUMERIC NULL,
  active_power_kw NUMERIC NULL,
  reactive_power_kvar NUMERIC NULL,
  power_factor NUMERIC NULL,
  energy_import_kwh NUMERIC NULL,
  balance NUMERIC NULL,
  switch_state INTEGER NULL,
  prestate TEXT NULL,
  owe_money INTEGER NULL,
  alarm_a INTEGER NULL,
  alarm_b INTEGER NULL,
  adf_state_1 TEXT NULL,
  adf_state_2 TEXT NULL,
  rssi INTEGER NULL,
  channel INTEGER NULL,
  mac_address TEXT NULL,
  raw_id UUID NULL REFERENCES telemetry_raw (id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_latest_state_product_key
  ON device_latest_state (product_key);
