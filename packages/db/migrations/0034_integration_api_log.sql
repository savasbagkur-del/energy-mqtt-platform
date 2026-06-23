-- Audit trail for 3rd-party integration API calls (EasyTech gateway, future /api/v1).

CREATE TABLE IF NOT EXISTS integration_api_log (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NULL REFERENCES customers (id) ON DELETE SET NULL,
  panel_user_id BIGINT NULL,
  username TEXT NULL,
  api_family TEXT NOT NULL DEFAULT 'easytech',
  direction TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  http_method TEXT NOT NULL,
  room_no TEXT NULL,
  sn TEXT NULL,
  switch_value SMALLINT NULL,
  success BOOLEAN NOT NULL,
  error_msg TEXT NULL,
  duration_ms INTEGER NULL,
  client_ip TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_api_log_direction_chk') THEN
    ALTER TABLE integration_api_log ADD CONSTRAINT integration_api_log_direction_chk
      CHECK (direction IN ('auth', 'read', 'control'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_integration_api_log_customer_created
  ON integration_api_log (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_api_log_created
  ON integration_api_log (created_at DESC);
