-- Faz 0 sertlestirme: ACK eslestirme ve reconciler sorgulari icin indexler,
-- ve gercek MQTT publish damgasi (idempotent/gozlemlenebilir publish).

ALTER TABLE commands
  ADD COLUMN IF NOT EXISTS last_publish_attempt_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN commands.last_publish_attempt_at IS
  'Set after a successful MQTT publish of this command (distinct from published_at set in claim tx).';

-- findCommandForAck: WHERE sn=$1 AND method=$3 AND status='published'
CREATE INDEX IF NOT EXISTS idx_commands_sn_method_status
  ON commands (sn, method, status);

-- Single-flight alt sorgusu + reconciler in-flight kontrolu icin kismi index
CREATE INDEX IF NOT EXISTS idx_commands_sn_status_active
  ON commands (sn, status)
  WHERE status IN ('created', 'scheduled', 'published', 'ack_received', 'verify_pending');
