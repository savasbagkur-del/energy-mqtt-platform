-- Maintenance / repair control-plane fields (snapshotted on commands.policy_snapshot at create).
ALTER TABLE command_policy_profiles
  ADD COLUMN IF NOT EXISTS auto_refresh_after_switch_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_refresh_delay_sec INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_finalize_from_child_refresh BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS parent_late_success_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Align retry mode naming with control plane: fixed ~= legacy schedule + min floor + jitter.
UPDATE command_policy_profiles
SET retry_backoff_mode = 'fixed'
WHERE retry_backoff_mode = 'schedule_plus_jitter';

COMMENT ON COLUMN command_policy_profiles.auto_refresh_delay_sec IS 'Seconds to defer scheduled child refresh after switch ACK (outbox-style ordering hook).';
COMMENT ON COLUMN command_policy_profiles.parent_finalize_from_child_refresh IS 'When false, child refresh success does not auto-close parent switch.';
