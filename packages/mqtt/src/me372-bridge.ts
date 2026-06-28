import { buildTopic } from "./topic.js";

/** meter-bridge / Nano ESP32 publish pattern */
export const ME372_BRIDGE_TOPIC_RE = /^energy\/telemetry\/([^/]+)\/([^/]+)\/up$/;

export const DEFAULT_ME372_PRODUCT_KEY = "ME372_IEC";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
};

export const isMe372BridgeTopic = (topic: string): boolean => ME372_BRIDGE_TOPIC_RE.test(topic);

export interface Me372BridgeTranslation {
  topic: string;
  payloadText: string;
  meterId: string;
  siteId: string;
  deviceId: string;
}

/**
 * Converts meter-bridge IEC Mode C envelope JSON into an Acrel-like `data/up` update
 * so Volt4Amper mqtt-worker persistence + app.volt4amper.com can ingest it.
 */
export const translateMe372BridgeMessage = (
  topic: string,
  payloadText: string,
  productKey: string = DEFAULT_ME372_PRODUCT_KEY
): Me372BridgeTranslation | null => {
  const match = topic.match(ME372_BRIDGE_TOPIC_RE);
  if (!match) {
    return null;
  }

  const siteId = match[1] ?? "";
  const bridgeDeviceId = match[2] ?? "";

  let envelope: Record<string, unknown>;
  try {
    envelope = asRecord(JSON.parse(payloadText)) ?? {};
  } catch {
    return null;
  }

  const meterData = asRecord(envelope.data);
  if (!meterData) {
    return null;
  }

  const meterId = asNonEmptyString(meterData.meter_id);
  if (!meterId) {
    return null;
  }

  const activeImport = toNumeric(meterData.active_import_kwh);
  if (activeImport === null) {
    return null;
  }

  const msgid =
    asNonEmptyString(envelope.timestamp_ms) ??
    asNonEmptyString(meterData.timestamp_utc) ??
    String(Date.now());

  const timestamp =
    asNonEmptyString(meterData.timestamp_utc) ??
    asNonEmptyString(envelope.timestamp_ms) ??
    new Date().toISOString();

  const reported: Record<string, unknown> = {
    state: 1,
    EPI: activeImport,
    source: asNonEmptyString(meterData.source) ?? "me372_iec_mode_c"
  };

  const pmaxImport = toNumeric(meterData.pmax_import_kw);
  if (pmaxImport !== null) {
    reported.MEPIMD = pmaxImport;
  }

  const activeExport = toNumeric(meterData.active_export_kwh);
  if (activeExport !== null) {
    reported.EPE = activeExport;
  }

  const reactivePlus = toNumeric(meterData.reactive_qplus_kvarh);
  if (reactivePlus !== null) {
    reported.EQI = reactivePlus;
  }

  const reactiveMinus = toNumeric(meterData.reactive_qminus_kvarh);
  if (reactiveMinus !== null) {
    reported.EQE = reactiveMinus;
  }

  const outPayload: Record<string, unknown> = {
    sn: meterId,
    method: "update",
    msgid,
    timestamp,
    reported,
    _me372_bridge: {
      site_id: asNonEmptyString(envelope.site_id) ?? siteId,
      device_id: asNonEmptyString(envelope.device_id) ?? bridgeDeviceId,
      reader_mode: asNonEmptyString(envelope.reader_mode),
      protocol: asNonEmptyString(meterData.protocol),
      ident_line: asNonEmptyString(meterData.ident_line),
      bcc: asNonEmptyString(meterData.bcc),
      original_topic: topic
    }
  };

  return {
    topic: buildTopic("data", "up", productKey, meterId),
    payloadText: JSON.stringify(outPayload),
    meterId,
    siteId: asNonEmptyString(envelope.site_id) ?? siteId,
    deviceId: asNonEmptyString(envelope.device_id) ?? bridgeDeviceId
  };
};
