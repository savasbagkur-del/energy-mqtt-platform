-- Bounded 3-cycle switch command model + per-device wake interval + alarm ledger.
--
-- Model (operator-approved):
--   * Each reconciler-issued force_switch command = one "cycle". Inside a cycle the worker
--     republishes every `cycle interval` seconds across a bounded delivery window
--     (interval * signals_per_cycle), i.e. ~10 signals per cycle.
--   * cycle_no on device_desired_state tracks 1->2->3.
--   * After `command_cycle_count` cycles without device state confirmation, the desired state
--     goes 'needs_attention' and a COMMAND_CONFIRMATION_TIMEOUT alarm is raised. The desired
--     state is NOT dropped; it resumes (fresh cycle budget) when the device next comes online
--     or the operator re-issues the command.
--   * Routine read-polling is intentionally NOT scheduled (devices push data/up on their own);
--     wake_interval_minutes is used only for the "next expected wake" estimate / offline waiting.

-- 1) Cycle counter on the durable switch intent. (reconcile_status is plain TEXT + comment,
--    no CHECK constraint, so 'needs_attention' is accepted without altering a constraint.)
ALTER TABLE device_desired_state
  ADD COLUMN IF NOT EXISTS cycle_no INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN device_desired_state.reconcile_status IS
  'pending|in_flight|reconciled|unreachable|needs_attention|superseded|cancelled';
COMMENT ON COLUMN device_desired_state.cycle_no IS
  'Bounded retry cycle index (0=henuz baslamadi, 1..command_cycle_count). command_cycle_count''e ulasip teyit gelmezse needs_attention.';

-- 2) Per-device wake interval (override). NULL => model/project default resolved in app layer.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS wake_interval_minutes INTEGER NULL,
  ADD COLUMN IF NOT EXISTS last_poll_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN devices.wake_interval_minutes IS
  'Cihaz bazli beklenen uyanma/raporlama periyodu (dk). NULL ise proje+model default uygulama katmaninda cozulur.';

-- 3) Cycle policy knobs on the command policy profile.
ALTER TABLE command_policy_profiles
  ADD COLUMN IF NOT EXISTS command_cycle_count INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS command_signals_per_cycle INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS command_cycle_intervals_sec JSONB NOT NULL DEFAULT '[10, 10, 7]'::jsonb;

COMMENT ON COLUMN command_policy_profiles.command_cycle_count IS 'Ac/kapat icin maksimum cycle sayisi (sonra needs_attention + alarm).';
COMMENT ON COLUMN command_policy_profiles.command_signals_per_cycle IS 'Her cycle icinde gonderilecek sinyal (republish) sayisi.';
COMMENT ON COLUMN command_policy_profiles.command_cycle_intervals_sec IS 'Cycle bazli sinyal araligi (sn) dizisi; ornek [10,10,7]. Eksik index son degeri kullanir.';

-- 4) Alarm ledger (UI-visible, acknowledgeable). One open alarm per (sn, alarm_type).
CREATE TABLE IF NOT EXISTS device_alarms (
  id               BIGSERIAL PRIMARY KEY,
  sn               TEXT NOT NULL,
  command_id       BIGINT NULL REFERENCES commands(id) ON DELETE SET NULL,
  desired_state_id BIGINT NULL REFERENCES device_desired_state(id) ON DELETE SET NULL,
  alarm_type       TEXT NOT NULL,                       -- 'COMMAND_CONFIRMATION_TIMEOUT' | ...
  severity         TEXT NOT NULL DEFAULT 'warning',     -- 'info' | 'warning' | 'critical'
  status           TEXT NOT NULL DEFAULT 'open',        -- 'open' | 'cleared' | 'acknowledged'
  message          TEXT NULL,
  fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  raised_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at       TIMESTAMPTZ NULL,
  acknowledged_at  TIMESTAMPTZ NULL,
  acknowledged_by  TEXT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_alarms_sn_status ON device_alarms (sn, status);
CREATE INDEX IF NOT EXISTS idx_device_alarms_raised_at ON device_alarms (raised_at DESC);

-- At most one OPEN alarm of a given type per device (idempotent re-raise via ON CONFLICT).
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_alarms_open_per_type
  ON device_alarms (sn, alarm_type) WHERE status = 'open';
