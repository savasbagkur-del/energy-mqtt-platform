-- ME372 optical (MeterEye1014) reports cumulative active export and reactive Q+/Q- energy
-- registers (EPE / EQI / EQE) that the Acrel-style structured columns did not cover.
-- Additive, nullable: Acrel meters that never send these keep NULL (no behavior change).
ALTER TABLE device_latest_state ADD COLUMN IF NOT EXISTS active_export_kwh NUMERIC NULL;
ALTER TABLE device_latest_state ADD COLUMN IF NOT EXISTS reactive_qplus_kvarh NUMERIC NULL;
ALTER TABLE device_latest_state ADD COLUMN IF NOT EXISTS reactive_qminus_kvarh NUMERIC NULL;

COMMENT ON COLUMN device_latest_state.active_export_kwh IS
  'Toplam aktif export enerjisi (kWh). ME372/MeterEye1014 EPE registresi.';
COMMENT ON COLUMN device_latest_state.reactive_qplus_kvarh IS
  'Toplam reaktif Q+ enerjisi (kVArh). ME372/MeterEye1014 EQI registresi.';
COMMENT ON COLUMN device_latest_state.reactive_qminus_kvarh IS
  'Toplam reaktif Q- enerjisi (kVArh). ME372/MeterEye1014 EQE registresi.';
