/**
 * Maps MQTT-ingested DB rows → EasyTech Prepaid API response objects.
 *
 * Source legend (for maintainers):
 *   mqtt  — device_latest_state / devices (from Acrel MQTT update/login)
 *   meta  — devices registry (unit_no, model, meter_usage)
 *   n/a   — not in gateway scope; vendor doc field present with neutral default
 *           (payment / tariff / combined-metering live in 3rd-party billing software)
 */
import type { DeviceTelemetrySnapshot, FleetDeviceRow } from "@communication/db";
import {
  CONTROL_MODE_FORCED,
  CONTROL_MODE_PREPAID,
  SWITCH_OFF,
  UNCONNECT_OFFLINE,
  UNCONNECT_ONLINE,
  USER_STATUS_OPEN
} from "./spec.js";
import type { EasyTechMeterInfoData, EasyTechMeterListItem } from "./types.js";

const num = (v: number | null | undefined, fallback = 0): number =>
  v != null && Number.isFinite(v) ? v : fallback;

const oweMoneyBool = (owe: number | null | undefined): boolean => (owe ?? 0) > 0;

/** controlMode boolean in getMeterList — true when forced/postpaid style. */
const controlModeListFlag = (meterUsage: string): boolean =>
  meterUsage === "postpaid" || meterUsage === "analysis";

/** controlMode string in getMeterInfo — "0" prepaid, "1" forced. */
const controlModeInfoString = (meterUsage: string): string =>
  controlModeListFlag(meterUsage) ? CONTROL_MODE_FORCED : CONTROL_MODE_PREPAID;

const switchStaInt = (state: number | null | undefined): number =>
  state === 1 ? 1 : SWITCH_OFF;

const switchStaString = (state: number | null | undefined): string =>
  String(switchStaInt(state));

const unConnect = (online: boolean): number => (online ? UNCONNECT_ONLINE : UNCONNECT_OFFLINE);

export const emptyTelemetrySnapshot = (sn: string): DeviceTelemetrySnapshot => ({
  sn,
  product_key: "",
  last_seen_at: "",
  last_method: "",
  last_topic: "",
  source: null,
  voltage_v: null,
  current_a: null,
  active_power_kw: null,
  reactive_power_kvar: null,
  power_factor: null,
  energy_import_kwh: null,
  balance: null,
  switch_state: null,
  prestate: null,
  owe_money: null,
  alarm_a: null,
  alarm_b: null,
  adf_state_1: null,
  adf_state_2: null,
  rssi: null,
  channel: null,
  mac_address: null,
  voltage_b_v: null,
  voltage_c_v: null,
  current_b_a: null,
  current_c_a: null,
  active_power_a_kw: null,
  active_power_b_kw: null,
  active_power_c_kw: null,
  power_factor_a: null,
  power_factor_b: null,
  power_factor_c: null,
  energy_sharp_kwh: null,
  energy_peak_kwh: null,
  energy_flat_kwh: null,
  energy_valley_kwh: null,
  max_demand_kw: null,
  updated_at: new Date().toISOString()
});

/** §2 getMeterList — one row per assigned meter. */
export const toMeterListItem = (row: FleetDeviceRow): EasyTechMeterListItem => ({
  meterID: row.sn,
  roomNo: row.unit_no ?? row.label ?? "",
  balance: num(row.balance),
  epi: num(row.energy_import_kwh),
  togetherMoney: 0,
  oweMoney: oweMoneyBool(row.owe_money),
  controlMode: controlModeListFlag(row.meter_usage),
  switchSta: switchStaInt(row.switch_state),
  unConnect: unConnect(row.online),
  together: false,
  credit: 0
});

/** §3 getMeterInfo — full detail object (all documented keys). */
export const toMeterInfoData = (input: {
  sn: string;
  roomNo: string;
  meterUsage: string;
  model: string | null;
  telemetry: DeviceTelemetrySnapshot;
  online: boolean;
}): EasyTechMeterInfoData => {
  const tel = input.telemetry;
  return {
    meterID: input.sn,
    roomNo: input.roomNo,
    startMoney: 0,
    totalMoney: 0,
    buyTimes: 0,
    alarmA: num(tel.alarm_a),
    alarmB: num(tel.alarm_b),
    priceSharp: 0,
    pricePeak: 0,
    priceFlat: 0,
    priceValley: 0,
    model: input.model ?? "",
    balance: num(tel.balance),
    togetherMoney: 0,
    p: num(tel.active_power_kw),
    epi: num(tel.energy_import_kwh),
    oweMoney: oweMoneyBool(tel.owe_money),
    userStatus: USER_STATUS_OPEN,
    controlMode: controlModeInfoString(input.meterUsage),
    switchSta: switchStaString(tel.switch_state),
    unConnect: unConnect(input.online),
    ct: 0,
    createTime: tel.last_seen_at || tel.updated_at || "",
    ub: num(tel.voltage_b_v),
    uc: num(tel.voltage_c_v),
    Ia: num(tel.current_a),
    Ib: num(tel.current_b_a),
    Ic: num(tel.current_c_a),
    ua: num(tel.voltage_v)
  };
};
