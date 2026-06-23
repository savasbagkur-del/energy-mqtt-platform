-- MD5 password hash for EasyTech-compatible /login (client sends MD5, not plaintext).

ALTER TABLE panel_users ADD COLUMN IF NOT EXISTS password_md5 TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_panel_users_password_md5 ON panel_users (password_md5)
  WHERE password_md5 IS NOT NULL;
