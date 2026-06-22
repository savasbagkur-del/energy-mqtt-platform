-- Link panel login accounts to a customer (viewer role for end-customer access).
ALTER TABLE panel_users ADD COLUMN IF NOT EXISTS customer_id BIGINT NULL REFERENCES customers (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_panel_users_customer ON panel_users (customer_id);
