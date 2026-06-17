-- Real-device command debugging: last commands, events, parent/child tree.
-- Run against the communication DB (adjust schema if your search_path differs).

-- Last 20 commands (newest first)
SELECT id,
       sn,
       product_key,
       command_type,
       status,
       parent_command_id,
       msgid,
       attempt_count,
       next_attempt_at,
       expires_at,
       published_at,
       ack_at,
       verified_at,
       completed_at,
       created_at
FROM commands
ORDER BY created_at DESC
LIMIT 20;

-- Events for one command (replace :command_id)
-- SELECT * FROM command_events WHERE command_id = :command_id ORDER BY created_at ASC;

-- Events for the last 20 commands
SELECT e.*
FROM command_events e
WHERE e.command_id IN (
  SELECT id FROM commands ORDER BY created_at DESC LIMIT 20
)
ORDER BY e.command_id, e.created_at ASC;

-- Parent row + all children for a given parent id (replace :parent_id)
SELECT *
FROM commands
WHERE id = :parent_id
   OR parent_command_id = :parent_id
ORDER BY parent_command_id NULLS FIRST, created_at ASC;

-- Find refresh child for a switch parent by parent id
SELECT *
FROM commands
WHERE parent_command_id = :parent_id
  AND command_type = 'refresh'
ORDER BY created_at DESC;
