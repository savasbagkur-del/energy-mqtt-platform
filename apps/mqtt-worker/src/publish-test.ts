import { appConfig } from "@communication/core";
import { buildTopic } from "@communication/mqtt";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

type TestMessageKind = "login" | "update" | "operate";

const PRODUCT = "testProduct";
const SERIAL = "testSn001";

const topicsByKind: Record<TestMessageKind, string> = {
  login: buildTopic("sys", "dev", PRODUCT, SERIAL),
  update: buildTopic("data", "up", PRODUCT, SERIAL),
  operate: buildTopic("indicate", "dev", PRODUCT, SERIAL)
};

const payloadByKind: Record<TestMessageKind, Record<string, unknown>> = {
  login: {
    sn: SERIAL,
    method: "login",
    msgid: "msg-login-001",
    timestamp: new Date().toISOString(),
    devname: "ACREL-TEST-METER",
    softcode: "ADM130",
    softversion: "1.2.3",
    network: {
      ip: "192.168.1.100",
      mac: "AA:BB:CC:DD:EE:FF",
      rssi: -62
    }
  },
  update: {
    sn: SERIAL,
    method: "update",
    msgid: "msg-update-001",
    timestamp: new Date().toISOString(),
    reported: {
      state: 1,
      Ua: 229.4,
      Ia: 5.12,
      P: 1174.5,
      PF: 0.98,
      EPI: 12345.67,
      Balance: 0,
      SwitchSta: 1
    }
  },
  operate: {
    sn: SERIAL,
    method: "operate",
    msgid: "msg-operate-001",
    timestamp: new Date().toISOString(),
    res: "ok"
  }
};

const asKind = (value: string | undefined): TestMessageKind => {
  if (value === "login" || value === "update" || value === "operate") {
    return value;
  }

  throw new Error("publish type must be one of: login | update | operate");
};

const connectMqtt = (brokerUrl: string, options: IClientOptions): Promise<MqttClient> =>
  new Promise((resolve, reject) => {
    const client = mqtt.connect(brokerUrl, options);

    client.once("connect", () => resolve(client));
    client.once("error", (error) => reject(error));
  });

const run = async (): Promise<void> => {
  const kind = asKind(process.argv[2]);
  const host = appConfig.mqttHost ?? "localhost";
  const port = appConfig.mqttPort ?? 1883;
  const brokerUrl = `mqtt://${host}:${port}`;
  const clientId = `${appConfig.mqttClientId ?? "communication-worker"}-publisher`;
  const topic = topicsByKind[kind];
  const payload = JSON.stringify(payloadByKind[kind]);

  const options: IClientOptions = {
    clientId,
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

  const client = await connectMqtt(brokerUrl, options);

  await new Promise<void>((resolve, reject) => {
    client.publish(topic, payload, { qos: 0 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  console.log("[mqtt-publisher] publish success", {
    kind,
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
  console.error("[mqtt-publisher] publish failed", { message });
  process.exitCode = 1;
});
