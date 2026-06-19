-- Panel users: admin-controlled login accounts for the web UI (app.volt4amper.com).
-- Replaces the single shared API token for human access with named accounts + roles.
-- The static service token (API_AUTH_TOKEN) stays valid for machine/backend callers.
--   role: 'admin'    -> full access + user management
--         'operator' -> view + device control (switch/refresh)
--         'viewer'   -> read-only (no control, no user management)

CREATE TABLE IF NOT EXISTS panel_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'panel_users_role_chk') THEN
    ALTER TABLE panel_users ADD CONSTRAINT panel_users_role_chk
      CHECK (role IN ('admin', 'operator', 'viewer'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_panel_users_active ON panel_users (is_active);
