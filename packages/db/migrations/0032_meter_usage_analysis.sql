-- Replace postpaid meter_usage with analysis (Analiz).

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_meter_usage_chk;

UPDATE devices SET meter_usage = 'analysis' WHERE meter_usage = 'postpaid';

ALTER TABLE devices ADD CONSTRAINT devices_meter_usage_chk
  CHECK (meter_usage IN ('prepaid', 'analysis'));
