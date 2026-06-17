/**
 * Standalone device emulator for end-to-end EMQX load tests.
 *
 * Mirrors apps/mqtt-worker/src/simulator.ts but over a REAL MQTT connection: it subscribes to the
 * command topics the worker publishes to and replies with ACK + telemetry, so commands genuinely
 * traverse the broker. Run with SIMULATOR_MODE disabled on the workers.
 *
 * Usage (PowerShell):
 *   $env:MQTT_URL="mqtt://localhost:1883"; node load-emulator.mjs
 *
 * SAFETY: point this only at a LOCAL/test broker, never at the production EMQX serving real devices.
 */
import mqtt from "mqtt";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const USERNAME = process.env.MQTT_USERNAME ?? "admin";
const PASSWORD = process.env.MQTT_PASSWORD ?? "public";
const ACK_DELAY_MS = Number(process.env.EMU_ACK_DELAY_MS ?? 100);
const UPDATE_DELAY_MS = Number(process.env.EMU_UPDATE_DELAY_MS ?? 250);

const deviceStateBySn = new Map();

const getState = (sn) => {
  let s = deviceStateBySn.get(sn);
  if (!s) {
    s = { switchState: 1 };
    deviceStateBySn.set(sn, s);
  }
  return s;
};

const toSwitchState = (v) => {
  if (v === 0 || v === "0") return 0;
  if (v === 1 || v === "1") return 1;
  return null;
};

const parseOutboundTopic = (topic) => {
  const seg = topic.split("/");
  const okHead =
    (seg[0] === "indicate" && seg[1] === "server") || (seg[0] === "sys" && seg[1] === "server");
  if (seg.length !== 4 || !okHead || !seg[2] || !seg[3]) return null;
  return { productKey: seg[2], sn: seg[3] };
};

let handled = 0;
let acks = 0;
let updates = 0;

const client = mqtt.connect(MQTT_URL, {
  username: USERNAME,
  password: PASSWORD,
  clientId: `device-emulator-${process.pid}`,
  clean: true,
  reconnectPeriod: 1000
});

client.on("connect", () => {
  client.subscribe(["indicate/server/#", "sys/server/#"], { qos: 1 }, (err, granted) => {
    if (err) {
      console.error("[emulator] subscribe error", err.message);
      process.exit(1);
    }
    console.log("[emulator] connected + subscribed", {
      url: MQTT_URL,
      granted: granted?.map((g) => `${g.topic} qos=${g.qos}`)
    });
  });
});

client.on("error", (err) => console.error("[emulator] error", err.message));

client.on("message", (topic, buf) => {
  const route = parseOutboundTopic(topic);
  if (!route) return;

  let payloadObj;
  try {
    payloadObj = JSON.parse(buf.toString("utf8"));
  } catch {
    return;
  }
  handled += 1;

  const inner =
    payloadObj && typeof payloadObj.payload === "object" && payloadObj.payload !== null
      ? payloadObj.payload
      : {};
  const innerMethod = typeof inner.method === "string" ? inner.method.trim().toUpperCase() : "";
  const msgidRaw = payloadObj.msgid;
  const msgid =
    typeof msgidRaw === "string"
      ? msgidRaw
      : typeof msgidRaw === "number"
        ? String(msgidRaw)
        : `emu-${Date.now()}`;

  const state = getState(route.sn);
  if (innerMethod === "FORCESWITCH") {
    const forced = toSwitchState(inner.ForceSwitch ?? inner.do1);
    if (forced !== null) state.switchState = forced;
  }

  const ackTopic = `indicate/dev/${route.productKey}/${route.sn}`;
  const ackBody = {
    sn: route.sn,
    method: "operate",
    msgid,
    timestamp: Math.floor(Date.now() / 1000),
    res: 1
  };
  if (innerMethod === "REFRESH") {
    ackBody.reported = { SwitchSta: state.switchState };
  }
  setTimeout(() => {
    client.publish(ackTopic, JSON.stringify(ackBody), { qos: 1 });
    acks += 1;
  }, ACK_DELAY_MS);

  if (innerMethod !== "REFRESH" && innerMethod !== "FORCESWITCH") return;

  const updateTopic = `data/up/${route.productKey}/${route.sn}`;
  const updateBody = {
    sn: route.sn,
    method: "update",
    msgid: `${msgid}-update`,
    timestamp: new Date().toISOString(),
    reported: {
      state: 1,
      Ua: 229.4,
      Ia: 5.12,
      P: 1174.5,
      PF: 0.98,
      EPI: 12345.67,
      Balance: 0,
      SwitchSta: state.switchState
    }
  };
  setTimeout(() => {
    client.publish(updateTopic, JSON.stringify(updateBody), { qos: 1 });
    updates += 1;
  }, UPDATE_DELAY_MS);
});

setInterval(() => {
  console.log("[emulator] stats", { handledCommands: handled, acksSent: acks, updatesSent: updates, devices: deviceStateBySn.size });
}, 5000);

const shutdown = () => {
  console.log("[emulator] shutting down", { handled, acks, updates });
  client.end(true, () => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
