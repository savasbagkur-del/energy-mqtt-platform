-- Customer integration model: how a customer is connected to the platform.
--   * Panel:  they use our web UI (panel_enabled flag, set by an operator).
--   * API:    they drive their own software through our API using a per-customer key.
--   * Both:   panel_enabled AND at least one active key.
-- API keys are stored only as a SHA-256 hash; the plaintext is shown once at creation.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS panel_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS customer_api_keys (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  label TEXT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_api_keys_hash ON customer_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_customer_api_keys_customer ON customer_api_keys (customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_api_keys_active ON customer_api_keys (is_active) WHERE is_active;
