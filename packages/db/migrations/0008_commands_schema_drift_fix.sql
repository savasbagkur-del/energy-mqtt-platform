ALTER TABLE IF EXISTS commands
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS policy_snapshot JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

UPDATE commands
SET policy_snapshot = '{}'::jsonb
WHERE policy_snapshot IS NULL;

ALTER TABLE IF EXISTS commands
  ALTER COLUMN policy_snapshot SET DEFAULT '{}'::jsonb,
  ALTER COLUMN policy_snapshot SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commands_next_attempt_at
  ON commands (next_attempt_at ASC);

CREATE INDEX IF NOT EXISTS idx_commands_status_next_attempt_at
  ON commands (status, next_attempt_at ASC);
