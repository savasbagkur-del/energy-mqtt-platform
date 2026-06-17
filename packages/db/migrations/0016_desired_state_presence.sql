-- Faz 1: Dayanikli komut cekirdegi.
--  device_desired_state : kalici irade (cevap gelene kadar tut; sadece iptal/supersede birakir)
--  device_presence      : cihaz online/offline (EMQX olaylari + telemetri tazeligi)
--  mqtt_client_bindings : clientid <-> (product_key, sn) trafikten ogrenilir (gateway uyumlu)
--  policy reconcile_*    : reconciler backoff/alarm ayarlari

CREATE TABLE IF NOT EXISTS device_desired_state (
  id                BIGSERIAL PRIMARY KEY,
  sn                TEXT NOT NULL,
  product_key       TEXT NULL,
  capability        TEXT NOT NULL,                    -- 'switch'
  desired_value     JSONB NOT NULL,                   -- {"switch": 0|1}
  reported_value    JSONB NULL,
  reconcile_status  TEXT NOT NULL DEFAULT 'pending',  -- pending|in_flight|reconciled|unreachable|superseded|cancelled
  desired_set_by    TEXT NULL,
  desired_set_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_command_id   BIGINT NULL REFERENCES commands(id) ON DELETE SET NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ NULL,
  next_eval_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reconciled_at     TIMESTAMPTZ NULL,
  unreachable_since TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_desired_state_sn_capability
  ON device_desired_state (sn, capability);

CREATE INDEX IF NOT EXISTS idx_device_desired_state_eval
  ON device_desired_state (reconcile_status, next_eval_at)
  WHERE reconcile_status IN ('pending', 'in_flight', 'unreachable');

CREATE TABLE IF NOT EXISTS device_presence (
  sn               TEXT PRIMARY KEY,
  status           TEXT NOT NULL,            -- 'online' | 'offline'
  connected_at     TIMESTAMPTZ NULL,
  disconnected_at  TIMESTAMPTZ NULL,
  last_event_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source           TEXT NULL,                -- 'mqtt_event' | 'lwt' | 'telemetry'
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mqtt_client_bindings (
  clientid         TEXT PRIMARY KEY,
  product_key      TEXT NULL,
  sn               TEXT NULL,
  gateway_clientid TEXT NULL,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mqtt_client_bindings_sn
  ON mqtt_client_bindings (sn);

ALTER TABLE command_policy_profiles
  ADD COLUMN IF NOT EXISTS reconcile_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reconcile_min_backoff_sec INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reconcile_max_backoff_sec INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS reconcile_unreachable_alarm_sec INTEGER NOT NULL DEFAULT 1800;

COMMENT ON COLUMN command_policy_profiles.reconcile_min_backoff_sec IS 'Reconciler: ardisik komut denemeleri arasi minimum backoff (saniye).';
COMMENT ON COLUMN command_policy_profiles.reconcile_max_backoff_sec IS 'Reconciler: backoff ust siniri (saniye).';
COMMENT ON COLUMN command_policy_profiles.reconcile_unreachable_alarm_sec IS 'Bu suredir reconcile olamayan cihaz icin alarm event esigi (retry durmaz).';
