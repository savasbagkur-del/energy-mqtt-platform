-- Append-only log of presence transitions (online ⇄ offline) so the UI can draw an uptime
-- timeline per device. device_presence keeps only the latest state; this keeps the history.
-- Rows are written by upsertPresence only when the status actually changes.
CREATE TABLE IF NOT EXISTS device_presence_events (
  id BIGSERIAL PRIMARY KEY,
  sn TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'online' | 'offline'
  source TEXT NULL,                -- 'mqtt_event' | 'lwt' | 'telemetry'
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_presence_events_sn_time
  ON device_presence_events (sn, event_at DESC);
