-- Device hardware model classification (drives per-model telemetry profiles).
-- Model is derived from the firmware-reported devname at login (e.g. "ADL200-NK-FWF" -> "ADL200").
-- NULL model => default profile (store every metric). 'ADL200' => single-phase basic profile
-- where only voltage / current / energy are persisted for analysis.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS model TEXT NULL;

-- Backfill known ADL200 meters already in the registry from their devname.
UPDATE devices
   SET model = 'ADL200'
 WHERE model IS NULL
   AND devname ILIKE '%ADL200%';
