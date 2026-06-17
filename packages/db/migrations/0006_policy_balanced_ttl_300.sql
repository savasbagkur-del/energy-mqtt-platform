ALTER TABLE command_policy_profiles
  ALTER COLUMN ack_timeout_sec SET DEFAULT 4,
  ALTER COLUMN verify_timeout_sec SET DEFAULT 90,
  ALTER COLUMN command_ttl_sec SET DEFAULT 300,
  ALTER COLUMN quick_retry_seconds SET DEFAULT '[0,3,8,20]'::jsonb,
  ALTER COLUMN slow_retry_seconds SET DEFAULT '[60,180,240]'::jsonb,
  ALTER COLUMN verify_refresh_delays_sec SET DEFAULT '[2,6,15]'::jsonb,
  ALTER COLUMN refresh_budget_per_hour SET DEFAULT 12,
  ALTER COLUMN diagnostics_interval_ms SET DEFAULT 1000,
  ALTER COLUMN diagnostics_duration_sec SET DEFAULT 30,
  ALTER COLUMN max_attempts SET DEFAULT 7;

UPDATE command_policy_profiles
SET
  ack_timeout_sec = 4,
  verify_timeout_sec = 90,
  command_ttl_sec = 300,
  quick_retry_seconds = '[0,3,8,20]'::jsonb,
  slow_retry_seconds = '[60,180,240]'::jsonb,
  verify_refresh_delays_sec = '[2,6,15]'::jsonb,
  refresh_budget_per_hour = 12,
  diagnostics_interval_ms = 1000,
  diagnostics_duration_sec = 30,
  max_attempts = 7,
  updated_at = NOW()
WHERE code = 'balanced';
