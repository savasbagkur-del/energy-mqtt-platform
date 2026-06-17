-- Delivery window + fixed retry interval (same command row; anchor for total ACK delivery SLA).
-- Communication fault flags for online-but-no-ack / no-verify (worker emits events).

ALTER TABLE commands
  ADD COLUMN IF NOT EXISTS delivery_window_anchor_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN commands.delivery_window_anchor_at IS 'Set on first transition to published; total delivery window is measured from this instant.';

ALTER TABLE command_policy_profiles
  ADD COLUMN IF NOT EXISTS retry_interval_sec INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS delivery_window_sec INTEGER NOT NULL DEFAULT 720,
  ADD COLUMN IF NOT EXISTS raise_communication_fault_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fault_if_online_but_no_ack_after_sec INTEGER NULL,
  ADD COLUMN IF NOT EXISTS fault_if_online_but_no_verify_after_sec INTEGER NULL;

COMMENT ON COLUMN command_policy_profiles.retry_interval_sec IS 'Seconds between republish attempts while awaiting ACK (same command id).';
COMMENT ON COLUMN command_policy_profiles.delivery_window_sec IS 'Total seconds from first publish (anchor) to stop ACK retries and fail delivery.';
COMMENT ON COLUMN command_policy_profiles.raise_communication_fault_enabled IS 'Emit device_online_but_no_*_fault events when thresholds hit.';
COMMENT ON COLUMN command_policy_profiles.fault_if_online_but_no_ack_after_sec IS 'Optional; defaults to delivery_window_sec when NULL.';
COMMENT ON COLUMN command_policy_profiles.fault_if_online_but_no_verify_after_sec IS 'Optional; defaults to verify phase window when NULL.';

-- Saha-friendly defaults on existing saha device profile if present
UPDATE command_policy_profiles
SET
  ack_timeout_sec = 20,
  retry_interval_sec = 30,
  delivery_window_sec = 720,
  verify_timeout_sec = GREATEST(verify_timeout_sec, 420),
  telemetry_cycle_sec = 300,
  single_flight_enabled = TRUE,
  updated_at = NOW()
WHERE code = 'saha_sn_24042809890002';
