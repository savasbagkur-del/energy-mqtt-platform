ALTER TABLE commands
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_commands_status_next_attempt_at
  ON commands (status, next_attempt_at ASC);

CREATE INDEX IF NOT EXISTS idx_commands_sn_status
  ON commands (sn, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS command_policy_profiles (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ack_timeout_sec INTEGER NOT NULL DEFAULT 4,
  verify_timeout_sec INTEGER NOT NULL DEFAULT 90,
  command_ttl_sec INTEGER NOT NULL DEFAULT 300,
  quick_retry_seconds JSONB NOT NULL DEFAULT '[0,3,8,20]'::jsonb,
  slow_retry_seconds JSONB NOT NULL DEFAULT '[60,180,240]'::jsonb,
  verify_refresh_delays_sec JSONB NOT NULL DEFAULT '[2,6,15]'::jsonb,
  refresh_budget_per_hour INTEGER NOT NULL DEFAULT 12,
  diagnostics_interval_ms INTEGER NOT NULL DEFAULT 1000,
  diagnostics_duration_sec INTEGER NOT NULL DEFAULT 30,
  max_attempts INTEGER NOT NULL DEFAULT 7,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_command_policy_profiles_single_default
  ON command_policy_profiles ((is_default))
  WHERE is_default = TRUE;

CREATE TABLE IF NOT EXISTS device_command_policy_overrides (
  id BIGSERIAL PRIMARY KEY,
  sn TEXT NOT NULL,
  product_key TEXT NULL,
  command_type TEXT NULL,
  policy_profile_id BIGINT NOT NULL REFERENCES command_policy_profiles (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_policy_override_unique
  ON device_command_policy_overrides (sn, COALESCE(product_key, ''), COALESCE(command_type, ''));

CREATE TABLE IF NOT EXISTS diagnostic_runs (
  id BIGSERIAL PRIMARY KEY,
  sn TEXT NOT NULL,
  product_key TEXT NOT NULL,
  status TEXT NOT NULL,
  interval_ms INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  planned_count INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  ack_count INTEGER NOT NULL DEFAULT 0,
  response_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_runs_sn_created_at
  ON diagnostic_runs (sn, created_at DESC);

INSERT INTO command_policy_profiles (
  code,
  name,
  is_default,
  enabled,
  ack_timeout_sec,
  verify_timeout_sec,
  command_ttl_sec,
  quick_retry_seconds,
  slow_retry_seconds,
  verify_refresh_delays_sec,
  refresh_budget_per_hour,
  diagnostics_interval_ms,
  diagnostics_duration_sec,
  max_attempts
)
VALUES (
  'balanced',
  'Balanced',
  TRUE,
  TRUE,
  4,
  90,
  300,
  '[0,3,8,20]'::jsonb,
  '[60,180,240]'::jsonb,
  '[2,6,15]'::jsonb,
  12,
  1000,
  30,
  7
)
ON CONFLICT (code) DO NOTHING;
