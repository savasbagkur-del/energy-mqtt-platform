import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isMe372BridgeTopic,
  translateMe372BridgeMessage
} from "@communication/mqtt";

const SAMPLE_ENVELOPE = {
  timestamp_ms: 1719523200000,
  site_id: "site-001",
  device_id: "meter-001",
  reader_mode: "iec62056_21",
  data: {
    meter_id: "50798309",
    active_import_kwh: 44.9,
    active_export_kwh: 0,
    reactive_qplus_kvarh: 7.3,
    reactive_qminus_kvarh: 19.8,
    pmax_import_kw: 0.074,
    protocol: "iec62056_21_mode_c",
    timestamp_utc: "2026-06-27T21:00:00.000Z",
    bcc: "valid",
    source: "nano_esp32"
  }
};

test("isMe372BridgeTopic matches meter-bridge telemetry topic", () => {
  assert.equal(isMe372BridgeTopic("energy/telemetry/site-001/meter-001/up"), true);
  assert.equal(isMe372BridgeTopic("data/up/foo/bar"), false);
});

test("translateMe372BridgeMessage maps envelope to data/up update", () => {
  const topic = "energy/telemetry/site-001/meter-001/up";
  const translated = translateMe372BridgeMessage(
    topic,
    JSON.stringify(SAMPLE_ENVELOPE),
    "ME372_IEC"
  );
  assert.ok(translated);
  assert.equal(translated.topic, "data/up/ME372_IEC/50798309");
  assert.equal(translated.meterId, "50798309");

  const payload = JSON.parse(translated.payloadText) as {
    sn: string;
    method: string;
    reported: Record<string, unknown>;
  };
  assert.equal(payload.sn, "50798309");
  assert.equal(payload.method, "update");
  assert.equal(payload.reported.EPI, 44.9);
  assert.equal(payload.reported.MEPIMD, 0.074);
  assert.equal(payload.reported.EQI, 7.3);
  assert.equal(payload.reported.EQE, 19.8);
});

test("translateMe372BridgeMessage rejects missing energy field", () => {
  const bad = {
    ...SAMPLE_ENVELOPE,
    data: { ...SAMPLE_ENVELOPE.data, active_import_kwh: undefined }
  };
  const translated = translateMe372BridgeMessage(
    "energy/telemetry/site-001/meter-001/up",
    JSON.stringify(bad)
  );
  assert.equal(translated, null);
});
