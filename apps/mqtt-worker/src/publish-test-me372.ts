import { appConfig } from "@communication/core";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

const connectMqtt = (brokerUrl: string, options: IClientOptions): Promise<MqttClient> =>
  new Promise((resolve, reject) => {
    const client = mqtt.connect(brokerUrl, options);
    client.once("connect", () => resolve(client));
    client.once("error", (error) => reject(error));
  });

const run = async (): Promise<void> => {
  const host = appConfig.mqttHost ?? "localhost";
  const port = appConfig.mqttPort ?? 1883;
  const tls = appConfig.mqttTls;
  const brokerUrl = `${tls ? "mqtts" : "mqtt"}://${host}:${port}`;
  const topic = "energy/telemetry/site-001/meter-001/up";
  const payload = JSON.stringify({
    timestamp_ms: Date.now(),
    site_id: "site-001",
    device_id: "meter-001",
    reader_mode: "iec62056_21",
    data: {
      meter_id: process.env.ME372_TEST_METER_ID ?? "50798309",
      active_import_kwh: 44.9,
      active_export_kwh: 0,
      reactive_qplus_kvarh: 7.3,
      reactive_qminus_kvarh: 19.8,
      pmax_import_kw: 0.074,
      protocol: "iec62056_21_mode_c",
      timestamp_utc: new Date().toISOString(),
      bcc: "valid",
      source: "publish-test-me372"
    }
  });

  const options: IClientOptions = {
    clientId: `${appConfig.mqttClientId ?? "communication-worker"}-me372-test`,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    clean: true
  };

  if (appConfig.mqttUsername) {
    options.username = appConfig.mqttUsername;
  }
  if (appConfig.mqttPassword) {
    options.password = appConfig.mqttPassword;
  }
  if (tls) {
    options.rejectUnauthorized = appConfig.mqttTlsRejectUnauthorized;
  }

  const client = await connectMqtt(brokerUrl, options);
  await new Promise<void>((resolve, reject) => {
    client.publish(topic, payload, { qos: 1 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  console.log("[mqtt-publisher] me372 bridge test publish success", {
    brokerUrl,
    topic,
    payload
  });

  await new Promise<void>((resolve) => {
    client.end(false, {}, () => resolve());
  });
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error("[mqtt-publisher] me372 test publish failed", { message });
  process.exitCode = 1;
});
