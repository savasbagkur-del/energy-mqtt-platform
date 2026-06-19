-- Three-phase + time-of-use tariff metrics for richer meters (e.g. ADL300).
-- Single-phase meters and consumption-mode devices simply leave these NULL.
-- Mapping (Acrel keys): Ub/Uc, Ib/Ic, Pa/Pb/Pc, PFa/PFb/PFc,
--   EPIJ=sharp, EPIF=peak, EPIP=flat/day, EPIG=valley/night, MEPIMD=max demand.

ALTER TABLE telemetry_samples
  ADD COLUMN IF NOT EXISTS voltage_b_v NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS voltage_c_v NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS current_b_a NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS current_c_a NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS active_power_a_kw NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS active_power_b_kw NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS active_power_c_kw NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS power_factor_a NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS power_factor_b NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS power_factor_c NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_sharp_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_peak_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_flat_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_valley_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS max_demand_kw NUMERIC NULL;

ALTER TABLE device_latest_state
  ADD COLUMN IF NOT EXISTS voltage_b_v NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS voltage_c_v NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS current_b_a NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS current_c_a NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS active_power_a_kw NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS active_power_b_kw NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS active_power_c_kw NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS power_factor_a NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS power_factor_b NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS power_factor_c NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_sharp_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_peak_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_flat_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS energy_valley_kwh NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS max_demand_kw NUMERIC NULL;
