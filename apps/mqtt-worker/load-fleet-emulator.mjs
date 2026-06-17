/**
 * Realistic fleet emulator for end-to-end scale/load tests over a REAL (local) MQTT broker.
 *
 * Unlike load-emulator.mjs (purely reactive), this simulates a FLEET of devices that behave like the
 * unstable Acrel meters we target: each device has its own wake/sleep CADENCE — it is online for a
 * short burst (~seconds) every ~cycle seconds and effectively OFFLINE in between. While "asleep" the
 * device drops inbound commands (simulating the broker's clean-session message loss), which is what
 * forces the worker's wake-flush + presence-gating + reconcile/retry paths to do real work.
 *
 * On each wake a device publishes: login (drives cadence learning) -> a few telemetry updates
 * (drives presence/last_seen + verification). It answers commands ONLY while awake, with ACK +
 * telemetry reflecting the new switch state.
 *
 * SAFETY: point this ONLY at a local/test broker. Never the production EMQX serving real devices.
 *
 * Usage (PowerShell):
 *   $env:MQTT_URL="mqtt://localhost:1883"; $env:MQTT_USERNAME="admin"; $env:MQTT_PASSWORD="public";
 *   $env:FLEET_SIZE="100"; node load-fleet-emulator.mjs
 */
import mqtt from "mqtt";

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const USERNAME = process.env.MQTT_USERNAME ?? "admin";
const PASSWORD = process.env.MQTT_PASSWORD ?? "public";
const FLEET_SIZE = num(process.env.FLEET_SIZE, 100);
const FLEET_START = num(process.env.FLEET_START, 1); // first device index (partition multiple emulators)
const PRODUCT_KEY = process.env.FLEET_PRODUCT_KEY ?? "LOADPK";
const SN_PREFIX = process.env.SN_PREFIX ?? "LOAD";
const CYCLE_SEC_MEAN = num(process.env.CYCLE_SEC_MEAN, 90);
const CYCLE_SEC_JITTER = num(process.env.CYCLE_SEC_JITTER, 20);
const ONLINE_WINDOW_SEC = num(process.env.ONLINE_WINDOW_SEC, 8);
const ACK_DELAY_MS = num(process.env.ACK_DELAY_MS, 150);
const TELEMETRY_PER_WINDOW = num(process.env.TELEMETRY_PER_WINDOW, 2);
const INITIAL_SWITCH = num(process.env.INITIAL_SWITCH, 1) === 0 ? 0 : 1;
const DROP_WHILE_ASLEEP = (process.env.DROP_WHILE_ASLEEP ?? "true").toLowerCase() !== "false";
const STARTUP_SPREAD_SEC = num(process.env.STARTUP_SPREAD_SEC, CYCLE_SEC_MEAN);
const ALWAYS_ONLINE_PCT = num(process.env.ALWAYS_ONLINE_PCT, 0); // 0..100, devices with no sleep

const pad = (i) => String(i).padStart(6, "0");
const snFor = (i) => `${SN_PREFIX}${pad(i)}`;
const jitter = (mean, spread) => mean + (Math.random() * 2 - 1) * spread;

const ADF_BIT = 0x8000;

// --- device registry ---
const devices = new Map(); // sn -> { switchState, awakeUntil, alwaysOnline }
for (let i = FLEET_START; i < FLEET_START + FLEET_SIZE; i += 1) {
  const sn = snFor(i);
  devices.set(sn, {
    switchState: INITIAL_SWITCH,
    awakeUntil: 0,
    alwaysOnline: Math.random() * 100 < ALWAYS_ONLINE_PCT
  });
}

const isAwake = (dev) => dev.alwaysOnline || Date.now() < dev.awakeUntil;

// --- stats ---
let loginsSent = 0;
let telemetrySent = 0;
let cmdReceived = 0;
let cmdRespondedAwake = 0;
let cmdDroppedAsleep = 0;
let acksSent = 0;

const parseOutboundTopic = (topic) => {
  const seg = topic.split("/");
  const okHead =
    (seg[0] === "indicate" && seg[1] === "server") || (seg[0] === "sys" && seg[1] === "server");
  if (seg.length !== 4 || !okHead || !seg[2] || !seg[3]) return null;
  return { productKey: seg[2], sn: seg[3] };
};

const toSwitchState = (v) => (v === 0 || v === "0" ? 0 : v === 1 || v === "1" ? 1 : null);

const client = mqtt.connect(MQTT_URL, {
  username: USERNAME,
  password: PASSWORD,
  clientId: `fleet-emulator-${process.pid}`,
  clean: true,
  reconnectPeriod: 1000
});

const publishLogin = (sn) => {
  const topic = `sys/dev/${PRODUCT_KEY}/${sn}`;
  const body = { sn, method: "login", msgid: 0, timestamp: Math.floor(Date.now() / 1000) };
  client.publish(topic, JSON.stringify(body), { qos: 1 });
  loginsSent += 1;
};

const publishTelemetry = (sn, dev) => {
  const topic = `data/up/${PRODUCT_KEY}/${sn}`;
  const sw = dev.switchState;
  const body = {
    sn,
    method: "update",
    msgid: `tlm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    timestamp: new Date().toISOString(),
    reported: {
      state: 1,
      Ua: 229.4,
      Ia: 5.12,
      P: 1174.5,
      PF: 0.98,
      EPI: 12345.67,
      Balance: 10,
      rssi: 60 + Math.floor(Math.random() * 20),
      SwitchSta: sw,
      AdfState1: sw === 1 ? ADF_BIT : 0
    }
  };
  client.publish(topic, JSON.stringify(body), { qos: 1 });
  telemetrySent += 1;
};

// One wake burst: login + spread telemetry across the online window, then schedule next wake.
const wake = (sn) => {
  const dev = devices.get(sn);
  if (!dev) return;
  dev.awakeUntil = Date.now() + ONLINE_WINDOW_SEC * 1000;
  publishLogin(sn);
  for (let k = 0; k < TELEMETRY_PER_WINDOW; k += 1) {
    const at = Math.floor(((k + 1) / (TELEMETRY_PER_WINDOW + 1)) * ONLINE_WINDOW_SEC * 1000);
    setTimeout(() => publishTelemetry(sn, dev), at);
  }
  if (!dev.alwaysOnline) {
    const nextSec = Math.max(20, jitter(CYCLE_SEC_MEAN, CYCLE_SEC_JITTER));
    setTimeout(() => wake(sn), nextSec * 1000);
  }
};

client.on("connect", () => {
  client.subscribe(["indicate/server/#", "sys/server/#"], { qos: 1 }, (err, granted) => {
    if (err) {
      console.error("[fleet] subscribe error", err.message);
      process.exit(1);
    }
    console.log("[fleet] connected + subscribed", {
      url: MQTT_URL,
      fleetSize: FLEET_SIZE,
      cycleMeanSec: CYCLE_SEC_MEAN,
      onlineWindowSec: ONLINE_WINDOW_SEC,
      alwaysOnlinePct: ALWAYS_ONLINE_PCT,
      granted: granted?.map((g) => `${g.topic} qos=${g.qos}`)
    });
    // Always-online devices wake immediately and stream; cyclic devices spread their first wake.
    for (const [sn, dev] of devices) {
      if (dev.alwaysOnline) {
        wake(sn);
        setInterval(() => publishTelemetry(sn, dev), CYCLE_SEC_MEAN * 1000);
      } else {
        setTimeout(() => wake(sn), Math.random() * STARTUP_SPREAD_SEC * 1000);
      }
    }
  });
});

client.on("error", (err) => console.error("[fleet] error", err.message));
client.on("reconnect", () => console.warn("[fleet] reconnecting..."));

client.on("message", (topic, buf) => {
  const route = parseOutboundTopic(topic);
  if (!route) return;
  const dev = devices.get(route.sn);
  if (!dev) return; // not one of our fleet devices

  let payloadObj;
  try {
    payloadObj = JSON.parse(buf.toString("utf8"));
  } catch {
    return;
  }

  const inner =
    payloadObj && typeof payloadObj.payload === "object" && payloadObj.payload !== null
      ? payloadObj.payload
      : {};
  const innerMethod = typeof inner.method === "string" ? inner.method.trim().toUpperCase() : "";
  // Ignore the worker's login/time/topology protocol responses (also on sys/server/#); only real
  // operate commands carry a FORCESWITCH/REFRESH payload.
  if (innerMethod !== "FORCESWITCH" && innerMethod !== "REFRESH") {
    return;
  }
  cmdReceived += 1;

  // Simulate clean-session message loss: a sleeping device never receives the command.
  if (DROP_WHILE_ASLEEP && !isAwake(dev)) {
    cmdDroppedAsleep += 1;
    return;
  }
  cmdRespondedAwake += 1;

  const msgidRaw = payloadObj.msgid;
  const msgid =
    typeof msgidRaw === "string"
      ? msgidRaw
      : typeof msgidRaw === "number"
        ? String(msgidRaw)
        : `emu-${Date.now()}`;

  if (innerMethod === "FORCESWITCH") {
    const forced = toSwitchState(inner.ForceSwitch ?? inner.do1);
    if (forced !== null) dev.switchState = forced;
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
    ackBody.reported = { SwitchSta: dev.switchState, AdfState1: dev.switchState === 1 ? ADF_BIT : 0 };
  }
  setTimeout(() => {
    client.publish(ackTopic, JSON.stringify(ackBody), { qos: 1 });
    acksSent += 1;
  }, ACK_DELAY_MS);

  if (innerMethod === "REFRESH" || innerMethod === "FORCESWITCH") {
    // Reflect the resulting state via telemetry so the worker can VERIFY the command.
    setTimeout(() => publishTelemetry(route.sn, dev), ACK_DELAY_MS + 250);
  }
});

let lastReceived = 0;
setInterval(() => {
  const awake = [...devices.values()].filter((d) => isAwake(d)).length;
  const delta = cmdReceived - lastReceived;
  lastReceived = cmdReceived;
  console.log("[fleet] stats", {
    devices: devices.size,
    awakeNow: awake,
    loginsSent,
    telemetrySent,
    cmdReceived,
    cmdRespondedAwake,
    cmdDroppedAsleep,
    acksSent,
    cmdRatePerSec: Math.round(delta / 5)
  });
}, 5000);

const shutdown = () => {
  console.log("[fleet] shutting down", {
    loginsSent,
    telemetrySent,
    cmdReceived,
    cmdRespondedAwake,
    cmdDroppedAsleep,
    acksSent
  });
  client.end(true, () => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
