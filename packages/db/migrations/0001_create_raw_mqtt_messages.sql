CREATE TABLE IF NOT EXISTS raw_mqtt_messages (
  id BIGSERIAL PRIMARY KEY,
  direction TEXT NOT NULL,
  topic TEXT NOT NULL,
  device_sn TEXT NULL,
  product_key TEXT NULL,
  protocol_msgid TEXT NULL,
  method TEXT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  parse_status TEXT NOT NULL,
  parse_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_mqtt_messages_received_at
  ON raw_mqtt_messages (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_mqtt_messages_topic
  ON raw_mqtt_messages (topic);
