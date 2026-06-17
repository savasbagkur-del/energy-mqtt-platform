-- Dedicated command policy profile + device override for saha field testing (SN 24042809890002).
-- Idempotent: profile upserted by code; device row upserted by unique (sn, product_key, command_type) index.

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
  max_attempts,
  ack_retry_min_delay_sec,
  telemetry_cycle_sec,
  late_confirmation_window_sec,
  switch_budget_per_hour,
  single_flight_enabled,
  device_busy_mode,
  retry_backoff_mode,
  retry_jitter_pct,
  auto_refresh_after_switch_enabled,
  auto_refresh_delay_sec,
  parent_finalize_from_child_refresh,
  parent_late_success_enabled
)
VALUES (
  'saha_sn_24042809890002',
  'Saha test — SN 24042809890002 (patient ack/verify)',
  FALSE,
  TRUE,
  20,
  420,
  300,
  '[0,3,8,20]'::jsonb,
  '[60,180,240]'::jsonb,
  '[2,6,15]'::jsonb,
  12,
  1000,
  30,
  7,
  5,
  300,
  3600,
  48,
  TRUE,
  'reject',
  'fixed',
  20,
  TRUE,
  0,
  TRUE,
  TRUE
)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  enabled = EXCLUDED.enabled,
  ack_timeout_sec = EXCLUDED.ack_timeout_sec,
  verify_timeout_sec = EXCLUDED.verify_timeout_sec,
  command_ttl_sec = EXCLUDED.command_ttl_sec,
  quick_retry_seconds = EXCLUDED.quick_retry_seconds,
  slow_retry_seconds = EXCLUDED.slow_retry_seconds,
  verify_refresh_delays_sec = EXCLUDED.verify_refresh_delays_sec,
  refresh_budget_per_hour = EXCLUDED.refresh_budget_per_hour,
  diagnostics_interval_ms = EXCLUDED.diagnostics_interval_ms,
  diagnostics_duration_sec = EXCLUDED.diagnostics_duration_sec,
  max_attempts = EXCLUDED.max_attempts,
  ack_retry_min_delay_sec = EXCLUDED.ack_retry_min_delay_sec,
  telemetry_cycle_sec = EXCLUDED.telemetry_cycle_sec,
  late_confirmation_window_sec = EXCLUDED.late_confirmation_window_sec,
  switch_budget_per_hour = EXCLUDED.switch_budget_per_hour,
  single_flight_enabled = EXCLUDED.single_flight_enabled,
  device_busy_mode = EXCLUDED.device_busy_mode,
  retry_backoff_mode = EXCLUDED.retry_backoff_mode,
  retry_jitter_pct = EXCLUDED.retry_jitter_pct,
  auto_refresh_after_switch_enabled = EXCLUDED.auto_refresh_after_switch_enabled,
  auto_refresh_delay_sec = EXCLUDED.auto_refresh_delay_sec,
  parent_finalize_from_child_refresh = EXCLUDED.parent_finalize_from_child_refresh,
  parent_late_success_enabled = EXCLUDED.parent_late_success_enabled,
  updated_at = NOW();

INSERT INTO device_command_policy_overrides (sn, product_key, command_type, policy_profile_id)
SELECT '24042809890002', NULL, NULL, id
FROM command_policy_profiles
WHERE code = 'saha_sn_24042809890002'
ON CONFLICT (sn, COALESCE(product_key, ''), COALESCE(command_type, ''))
DO UPDATE SET
  policy_profile_id = EXCLUDED.policy_profile_id,
  updated_at = NOW();
