import type { NormalizedIncomingMessage } from "@communication/contracts";
import type { Pool } from "pg";
import { resolveSwitchState } from "./switch-decode.js";
import { recordReconnectObservation } from "./device-cadence.js";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asText = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
};

const resolvePayloadField = (
  payload: Record<string, unknown> | null,
  key: string
): unknown => {
  if (!payload) {
    return null;
  }
  const direct = payload[key];
  if (direct !== undefined && direct !== null) {
    return direct;
  }
  const data = asRecord(payload.data);
  if (!data) {
    return null;
  }
  return data[key] ?? null;
};

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    const parsedDate = new Date(millis);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    const millis = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    const parsedDate = new Date(millis);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed);
};

const toNumeric = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toInteger = (value: unknown): number | null => {
  const numeric = toNumeric(value);
  if (numeric === null) {
    return null;
  }
  return Math.trunc(numeric);
};

interface TelemetryMappedValues {
  source: string | null;
  voltageV: number | null;
  currentA: number | null;
  activePowerKw: number | null;
  reactivePowerKvar: number | null;
  powerFactor: number | null;
  energyImportKwh: number | null;
  balance: number | null;
  switchState: number | null;
  prestate: string | null;
  oweMoney: number | null;
  alarmA: number | null;
  alarmB: number | null;
  adfState1: string | null;
  adfState2: string | null;
  rssi: number | null;
  channel: number | null;
  macAddress: string | null;
}

/**
 * Per-device telemetry mode (chosen at registration).
 *
 *  'consumption' (Tuketim izleme): keep only voltage / current / total active
 *    energy. Everything else is dropped from the analysis sample; power /
 *    reactive / power factor are also nulled in the live snapshot.
 *  'analysis' (Enerji analiz) and null (legacy/unset): store every mapped metric.
 *
 * Control/prepaid fields (switch_state, balance, owe_money, alarms, rssi) are
 * always preserved in device_latest_state so relay control and prepaid billing
 * keep working regardless of mode.
 */
type TelemetryMode = "consumption" | "analysis" | null;

const applySampleProfile = (
  mapped: TelemetryMappedValues,
  mode: TelemetryMode
): TelemetryMappedValues => {
  if (mode === "consumption") {
    return {
      ...mapped,
      activePowerKw: null,
      reactivePowerKvar: null,
      powerFactor: null,
      balance: null,
      switchState: null,
      rssi: null,
      channel: null,
      macAddress: null
    };
  }
  // analysis / legacy: store everything we mapped.
  return mapped;
};

const applyLatestStateProfile = (
  mapped: TelemetryMappedValues,
  mode: TelemetryMode
): TelemetryMappedValues => {
  if (mode === "consumption") {
    return {
      ...mapped,
      activePowerKw: null,
      reactivePowerKvar: null,
      powerFactor: null
    };
  }
  return mapped;
};

const pickReportedNode = (
  payloadJson: Record<string, unknown> | null,
  sn: string
): Record<string, unknown> | null => {
  const reported = asRecord(payloadJson?.reported);
  if (!reported) {
    return null;
  }
  const bySn = asRecord(reported[sn]);
  if (bySn) {
    return bySn;
  }
  return reported;
};

const resolvePayloadDate = (
  payloadJson: Record<string, unknown> | null,
  sn: string,
  keys: string[]
): Date | null => {
  const reported = asRecord(payloadJson?.reported);
  const bySn = pickReportedNode(payloadJson, sn);
  for (const key of keys) {
    const value =
      resolvePayloadField(payloadJson, key) ??
      bySn?.[key] ??
      reported?.[key];
    const parsed = toDate(value);
    if (parsed) {
      return parsed;
    }
  }
  return null;
};

const mapTelemetryValues = (
  payloadJson: Record<string, unknown> | null,
  sn: string,
  allowAdfSwitchFallback: boolean
): TelemetryMappedValues => {
  const reported = asRecord(payloadJson?.reported);
  const bySn = pickReportedNode(payloadJson, sn);
  const network = asRecord(payloadJson?.network);
  const source =
    asText(reported?.source) ??
    asText(payloadJson?.source) ??
    asText(asRecord(payloadJson?.data)?.source);

  return {
    source,
    voltageV: toNumeric(bySn?.U ?? bySn?.Ua),
    currentA: toNumeric(bySn?.I ?? bySn?.Ia),
    activePowerKw: toNumeric(bySn?.P),
    reactivePowerKvar: toNumeric(bySn?.Q),
    powerFactor: toNumeric(bySn?.PF),
    energyImportKwh: toNumeric(bySn?.EPI),
    balance: toNumeric(bySn?.Balance),
    // SwitchSta wins; fall back to AdfState1 bit-15 decode for meters that omit SwitchSta.
    switchState: resolveSwitchState(bySn?.SwitchSta, bySn?.AdfState1, allowAdfSwitchFallback),
    prestate: asText(bySn?.PRESTATE),
    oweMoney: toInteger(bySn?.OweMoney),
    alarmA: toInteger(bySn?.AlarmA),
    alarmB: toInteger(bySn?.AlarmB),
    adfState1: asText(bySn?.AdfState1),
    adfState2: asText(bySn?.AdfState2),
    rssi: toInteger(bySn?.rssi ?? reported?.rssi ?? payloadJson?.rssi ?? network?.rssi),
    channel: toInteger(bySn?.channel ?? reported?.channel ?? payloadJson?.channel),
    macAddress:
      asText(bySn?.mac_address) ??
      asText(reported?.mac_address) ??
      asText(payloadJson?.mac_address) ??
      asText(network?.mac)
  };
};

const calcIngestLagMs = (receivedAt: Date, deviceSentAt: Date | null): number | null => {
  if (!deviceSentAt) {
    return null;
  }
  return Math.trunc(receivedAt.getTime() - deviceSentAt.getTime());
};

const calcDeviceReportLagSec = (
  deviceSentAt: Date | null,
  deviceSampleAt: Date | null
): number | null => {
  if (!deviceSentAt || !deviceSampleAt) {
    return null;
  }
  return Math.trunc((deviceSentAt.getTime() - deviceSampleAt.getTime()) / 1000);
};

const isDataUpUpdateEvent = (normalized: NormalizedIncomingMessage): boolean =>
  normalized.topic.channel === "data" &&
  normalized.topic.direction === "inbound" &&
  normalized.method === "update";

const isSysDeviceLifecycleEvent = (normalized: NormalizedIncomingMessage): boolean => {
  const direction = normalized.topic.segments[1]?.toLowerCase();
  const method = normalized.method?.toLowerCase();
  return (
    normalized.topic.channel === "sys" &&
    direction === "dev" &&
    (method === "login" || method === "topology")
  );
};

const pickLastSeenAt = (
  receivedAt: Date,
  deviceSentAt: Date | null,
  deviceSampleAt: Date | null
): Date => {
  if (deviceSentAt) {
    return deviceSentAt;
  }
  if (deviceSampleAt) {
    return deviceSampleAt;
  }
  return receivedAt;
};

const upsertDeviceLatestStateForDataUpdate = async (
  pool: Pool,
  params: {
    sn: string;
    productKey: string;
    method: string;
    msgid: string | null;
    topicRaw: string;
    mapped: TelemetryMappedValues;
    rawId: string;
    lastSeenAt: Date;
  }
): Promise<void> => {
  await pool.query(
    `INSERT INTO device_latest_state (
      sn,
      product_key,
      last_seen_at,
      last_method,
      last_msgid,
      last_topic,
      source,
      voltage_v,
      current_a,
      active_power_kw,
      reactive_power_kvar,
      power_factor,
      energy_import_kwh,
      balance,
      switch_state,
      prestate,
      owe_money,
      alarm_a,
      alarm_b,
      adf_state_1,
      adf_state_2,
      rssi,
      channel,
      mac_address,
      raw_id,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW()
    )
    ON CONFLICT (sn) DO UPDATE SET
      product_key = EXCLUDED.product_key,
      last_seen_at = EXCLUDED.last_seen_at,
      last_method = EXCLUDED.last_method,
      last_msgid = EXCLUDED.last_msgid,
      last_topic = EXCLUDED.last_topic,
      source = EXCLUDED.source,
      voltage_v = EXCLUDED.voltage_v,
      current_a = EXCLUDED.current_a,
      active_power_kw = EXCLUDED.active_power_kw,
      reactive_power_kvar = EXCLUDED.reactive_power_kvar,
      power_factor = EXCLUDED.power_factor,
      energy_import_kwh = EXCLUDED.energy_import_kwh,
      balance = EXCLUDED.balance,
      switch_state = EXCLUDED.switch_state,
      prestate = EXCLUDED.prestate,
      owe_money = EXCLUDED.owe_money,
      alarm_a = EXCLUDED.alarm_a,
      alarm_b = EXCLUDED.alarm_b,
      adf_state_1 = EXCLUDED.adf_state_1,
      adf_state_2 = EXCLUDED.adf_state_2,
      rssi = EXCLUDED.rssi,
      channel = EXCLUDED.channel,
      mac_address = EXCLUDED.mac_address,
      raw_id = EXCLUDED.raw_id,
      updated_at = NOW()`,
    [
      params.sn,
      params.productKey,
      params.lastSeenAt,
      params.method,
      params.msgid,
      params.topicRaw,
      params.mapped.source,
      params.mapped.voltageV,
      params.mapped.currentA,
      params.mapped.activePowerKw,
      params.mapped.reactivePowerKvar,
      params.mapped.powerFactor,
      params.mapped.energyImportKwh,
      params.mapped.balance,
      params.mapped.switchState,
      params.mapped.prestate,
      params.mapped.oweMoney,
      params.mapped.alarmA,
      params.mapped.alarmB,
      params.mapped.adfState1,
      params.mapped.adfState2,
      params.mapped.rssi,
      params.mapped.channel,
      params.mapped.macAddress,
      params.rawId
    ]
  );
};

const upsertDeviceLatestStateForSysLifecycle = async (
  pool: Pool,
  params: {
    sn: string;
    productKey: string;
    method: string;
    msgid: string | null;
    topicRaw: string;
    rawId: string;
    lastSeenAt: Date;
  }
): Promise<void> => {
  await pool.query(
    `INSERT INTO device_latest_state (
      sn,
      product_key,
      last_seen_at,
      last_method,
      last_msgid,
      last_topic,
      raw_id,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,NOW()
    )
    ON CONFLICT (sn) DO UPDATE SET
      product_key = EXCLUDED.product_key,
      last_seen_at = GREATEST(device_latest_state.last_seen_at, EXCLUDED.last_seen_at),
      raw_id = EXCLUDED.raw_id,
      updated_at = NOW()`,
    [
      params.sn,
      params.productKey,
      params.lastSeenAt,
      params.method,
      params.msgid,
      params.topicRaw,
      params.rawId
    ]
  );
};

export type TelemetryFoundationParseStatus = "parsed" | "parse_failed";

export interface PersistTelemetryFoundationInput {
  normalized: NormalizedIncomingMessage;
  receivedAt: Date;
  parseStatus: TelemetryFoundationParseStatus;
  /** Derive switch_state from AdfState1 when SwitchSta is absent (Acrel family). Default true. */
  deriveSwitchFromAdfState?: boolean;
}

/**
 * Writes telemetry foundation tables without changing existing raw_mqtt/latest_state flow.
 */
export const persistTelemetryFoundation = async (
  pool: Pool,
  input: PersistTelemetryFoundationInput
): Promise<void> => {
  const { normalized, receivedAt, parseStatus } = input;
  const sn = normalized.sn ?? normalized.topic.deviceId;
  const productKey = normalized.topic.deviceType;

  if (!sn || !productKey) {
    return;
  }

  const method = normalized.method ?? "unknown";
  const payloadForStorage: unknown = normalized.payloadJson ?? { raw: normalized.payloadText };
  const payloadJson = normalized.payloadJson;

  const deviceSampleAt =
    resolvePayloadDate(payloadJson, sn, ["timestamp", "sample_time", "sampletime"]) ??
    toDate(normalized.timestamp);
  const deviceSentAt = resolvePayloadDate(payloadJson, sn, [
    "sendtime",
    "send_time",
    "sendTime",
    "serversend",
    "server_send"
  ]);
  const ingestLagMs = calcIngestLagMs(receivedAt, deviceSentAt);
  const deviceReportLagSec = calcDeviceReportLagSec(deviceSentAt, deviceSampleAt);

  const payloadJsonText = JSON.stringify(payloadForStorage);

  const rawInsert = await pool.query<{ id: string }>(
    `INSERT INTO telemetry_raw (
      sn,
      product_key,
      topic,
      method,
      msgid,
      payload_json,
      parse_status,
      device_sample_at,
      device_sent_at,
      worker_received_at,
      persisted_at,
      ingest_lag_ms,
      device_report_lag_sec
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,NOW(),$11,$12
    )
    ON CONFLICT (sn, topic, method, msgid_norm, payload_fingerprint) DO NOTHING
    RETURNING id`,
    [
      sn,
      productKey,
      normalized.topic.raw,
      method,
      normalized.msgid,
      payloadJsonText,
      parseStatus,
      deviceSampleAt,
      deviceSentAt,
      receivedAt,
      ingestLagMs,
      deviceReportLagSec
    ]
  );

  let rawId = rawInsert.rows[0]?.id;
  let isDuplicateRaw = false;
  if (!rawId) {
    const existing = await pool.query<{ id: string }>(
      `SELECT id
       FROM telemetry_raw
       WHERE sn = $1
         AND topic = $2
         AND method = $3
         AND COALESCE(msgid, '') = COALESCE($4, '')
         AND payload_json = $5::jsonb
       ORDER BY created_at ASC
       LIMIT 1`,
      [sn, normalized.topic.raw, method, normalized.msgid, payloadJsonText]
    );
    rawId = existing.rows[0]?.id;
    isDuplicateRaw = true;
  }
  if (!rawId) {
    return;
  }

  if (isDuplicateRaw) {
    return;
  }

  const mapped = mapTelemetryValues(payloadJson, sn, input.deriveSwitchFromAdfState !== false);
  const observedAt = deviceSampleAt ?? deviceSentAt ?? receivedAt;

  // Resolve the device telemetry mode so we can apply its profile.
  // (PK lookup; returns null for unseen SNs => legacy "store everything".)
  const modeResult = await pool.query<{ telemetry_mode: string | null }>(
    `SELECT telemetry_mode FROM devices WHERE sn = $1`,
    [sn]
  );
  const rawMode = modeResult.rows[0]?.telemetry_mode ?? null;
  const telemetryMode: TelemetryMode =
    rawMode === "consumption" || rawMode === "analysis" ? rawMode : null;
  const sampleValues = applySampleProfile(mapped, telemetryMode);

  await pool.query(
    `INSERT INTO telemetry_samples (
      sn,
      product_key,
      observed_at,
      source,
      voltage_v,
      current_a,
      active_power_kw,
      reactive_power_kvar,
      power_factor,
      energy_import_kwh,
      balance,
      switch_state,
      rssi,
      channel,
      mac_address,
      raw_id
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
    )`,
    [
      sn,
      productKey,
      observedAt,
      sampleValues.source,
      sampleValues.voltageV,
      sampleValues.currentA,
      sampleValues.activePowerKw,
      sampleValues.reactivePowerKvar,
      sampleValues.powerFactor,
      sampleValues.energyImportKwh,
      sampleValues.balance,
      sampleValues.switchState,
      sampleValues.rssi,
      sampleValues.channel,
      sampleValues.macAddress,
      rawId
    ]
  );

  const lastSeenAt = pickLastSeenAt(receivedAt, deviceSentAt, deviceSampleAt);
  if (isDataUpUpdateEvent(normalized)) {
    await upsertDeviceLatestStateForDataUpdate(pool, {
      sn,
      productKey,
      method,
      msgid: normalized.msgid,
      topicRaw: normalized.topic.raw,
      mapped: applyLatestStateProfile(mapped, telemetryMode),
      rawId,
      lastSeenAt
    });
  } else if (isSysDeviceLifecycleEvent(normalized)) {
    await upsertDeviceLatestStateForSysLifecycle(pool, {
      sn,
      productKey,
      method,
      msgid: normalized.msgid,
      topicRaw: normalized.topic.raw,
      rawId,
      lastSeenAt
    });
  }

  // Faz C: learn the device's reconnect cadence from login events (server clock, dedup-filtered).
  if (method.toLowerCase() === "login") {
    try {
      await recordReconnectObservation(pool, { sn, productKey, observedAt: receivedAt });
    } catch {
      // cadence learning is best-effort; never block telemetry persistence on it
    }
  }
};
