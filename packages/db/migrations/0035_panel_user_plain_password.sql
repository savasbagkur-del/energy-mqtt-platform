-- Admin-visible panel password (set on create/update; not derivable from hashes).

ALTER TABLE panel_users ADD COLUMN IF NOT EXISTS plain_password TEXT NULL;
