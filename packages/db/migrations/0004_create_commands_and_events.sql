CREATE TABLE IF NOT EXISTS commands (
  id BIGSERIAL PRIMARY KEY,
  sn TEXT NOT NULL,
  product_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  method TEXT NOT NULL,
  msgid TEXT NOT NULL,
  parent_command_id BIGINT NULL REFERENCES commands (id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  request_payload JSONB NOT NULL,
  ack_payload JSONB NULL,
  verification_payload JSONB NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NULL,
  ack_at TIMESTAMPTZ NULL,
  verified_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_msgid_unique ON commands (msgid);
CREATE INDEX IF NOT EXISTS idx_commands_sn_created_at ON commands (sn, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commands_status_created_at ON commands (status, created_at ASC);

CREATE TABLE IF NOT EXISTS command_events (
  id BIGSERIAL PRIMARY KEY,
  command_id BIGINT NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_command_events_command_id_created_at
  ON command_events (command_id, created_at ASC);
