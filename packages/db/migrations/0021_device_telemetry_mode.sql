-- Per-device telemetry mode chosen at registration. Drives which metrics are
-- persisted for analysis (telemetry_samples) and shown live (device_latest_state).
--   'consumption' (Tuketim izleme) -> only voltage / current / total energy
--   'analysis'    (Enerji analiz)  -> consumption + active power + power factor
--   NULL                            -> legacy: store every mapped metric
-- Control/prepaid fields (switch_state, balance, owe_money, alarms) are always
-- kept in device_latest_state regardless of mode so relay control keeps working.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS telemetry_mode TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_telemetry_mode_chk') THEN
    ALTER TABLE devices ADD CONSTRAINT devices_telemetry_mode_chk
      CHECK (telemetry_mode IS NULL OR telemetry_mode IN ('consumption', 'analysis'));
  END IF;
END $$;

-- Preserve current behavior of the ADL200 meter (was restricted to V/A/kWh via
-- the model profile) by mapping it onto the explicit consumption mode.
UPDATE devices
   SET telemetry_mode = 'consumption'
 WHERE telemetry_mode IS NULL
   AND model = 'ADL200';
