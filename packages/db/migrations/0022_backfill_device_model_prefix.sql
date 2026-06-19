-- Backfill devices.model from the firmware devname prefix (family before first dash),
-- matching resolveDeviceModel(): "ADL300-EY-IOT" -> "ADL300", "DDSY1352-IOT" -> "DDSY1352".
-- Used as a label and to derive phase count in the UI (ADL3xx => three-phase).

UPDATE devices
   SET model = UPPER(split_part(devname, '-', 1))
 WHERE devname IS NOT NULL
   AND length(trim(devname)) > 0
   AND (model IS NULL OR model <> UPPER(split_part(devname, '-', 1)));
