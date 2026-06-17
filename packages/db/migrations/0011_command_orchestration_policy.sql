-- Orchestration tuning fields (profile-level; snapshotted onto commands.policy_snapshot at create time).
ALTER TABLE command_policy_profiles
  ADD COLUMN IF NOT EXISTS ack_retry_min_delay_sec INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS telemetry_cycle_sec INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS late_confirmation_window_sec INTEGER NOT NULL DEFAULT 3600,
  ADD COLUMN IF NOT EXISTS switch_budget_per_hour INTEGER NOT NULL DEFAULT 48,
  ADD COLUMN IF NOT EXISTS single_flight_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS device_busy_mode TEXT NOT NULL DEFAULT 'reject',
  ADD COLUMN IF NOT EXISTS retry_backoff_mode TEXT NOT NULL DEFAULT 'schedule_plus_jitter',
  ADD COLUMN IF NOT EXISTS retry_jitter_pct INTEGER NOT NULL DEFAULT 20;

COMMENT ON COLUMN command_policy_profiles.device_busy_mode IS 'reject | queue_slot (queue_slot reserved for future single-slot queue)';
COMMENT ON COLUMN command_policy_profiles.retry_backoff_mode IS 'schedule_plus_jitter (legacy max quick_retry vs min) | exponential | linear';
