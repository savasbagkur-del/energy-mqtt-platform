-- Idempotency for telemetry foundation: dedupe identical logical ingest rows (race-safe via unique constraint).

-- 0) Remove duplicate sample rows per raw_id (keep oldest).
DELETE FROM telemetry_samples
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY raw_id
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM telemetry_samples
  ) ranked
  WHERE ranked.rn > 1
);

-- 1) Remove existing duplicate raw rows (keep oldest by created_at, id), cascade samples.
DELETE FROM telemetry_samples
WHERE raw_id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          sn,
          topic,
          method,
          COALESCE(msgid, ''),
          encode(digest(payload_json::text, 'sha256'), 'hex')
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM telemetry_raw
  ) ranked
  WHERE ranked.rn > 1
);

DELETE FROM telemetry_raw
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          sn,
          topic,
          method,
          COALESCE(msgid, ''),
          encode(digest(payload_json::text, 'sha256'), 'hex')
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM telemetry_raw
  ) ranked
  WHERE ranked.rn > 1
);

-- 2) Generated columns for stable idempotency key (same logical payload -> same digest in PostgreSQL).
ALTER TABLE telemetry_raw
  ADD COLUMN IF NOT EXISTS msgid_norm TEXT
  GENERATED ALWAYS AS (COALESCE(msgid, '')) STORED;

ALTER TABLE telemetry_raw
  ADD COLUMN IF NOT EXISTS payload_fingerprint TEXT
  GENERATED ALWAYS AS (encode(digest(payload_json::text, 'sha256'), 'hex')) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_raw_idempotency_v1
  ON telemetry_raw (sn, topic, method, msgid_norm, payload_fingerprint);

-- 3) At most one sample row per raw ingest (defense in depth).
CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_samples_unique_raw_id
  ON telemetry_samples (raw_id);
