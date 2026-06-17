import { config as loadDotEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const rootEnvPath = resolve(currentDir, "../../..", ".env");

loadDotEnv({ path: rootEnvPath });

const readString = (value: string | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readNumber = (value: string | undefined): number | null => {
  const asString = readString(value);
  if (asString === null) {
    return null;
  }

  const asNumber = Number(asString);
  return Number.isFinite(asNumber) ? asNumber : null;
};

const readBoolean = (value: string | undefined): boolean => {
  const asString = readString(value);
  if (asString === null) {
    return false;
  }

  const normalized = asString.toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
};

export type CommandTopicMode = "indicate_server" | "sys_server";

const readCommandTopicMode = (value: string | undefined): CommandTopicMode => {
  const asString = readString(value);
  if (asString === null) {
    return "indicate_server";
  }
  const normalized = asString.toLowerCase().replace(/-/g, "_");
  return normalized === "sys_server" ? "sys_server" : "indicate_server";
};

const readPositiveInt = (value: string | undefined, fallback: number): number => {
  const n = readNumber(value);
  if (n === null || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(1, Math.floor(n));
};

/** Boolean env where an unset/blank value falls back to `fallback` (true-capable defaults). */
const readBooleanWithDefault = (value: string | undefined, fallback: boolean): boolean => {
  const asString = readString(value);
  if (asString === null) {
    return fallback;
  }
  const normalized = asString.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
};

export type MqttQos = 0 | 1 | 2;

const readMqttQos = (value: string | undefined, fallback: MqttQos): MqttQos => {
  const n = readNumber(value);
  if (n === 0 || n === 1 || n === 2) {
    return n;
  }
  return fallback;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

const readLogLevel = (value: string | undefined, fallback: LogLevel): LogLevel => {
  const s = readString(value)?.toLowerCase();
  if (s === "debug" || s === "info" || s === "warn" || s === "error") {
    return s;
  }
  return fallback;
};

const readNonNegativeInt = (value: string | undefined, fallback: number): number => {
  const n = readNumber(value);
  if (n === null || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.floor(n));
};

export interface AppConfig {
  nodeEnv: string;
  apiPort: number | null;
  postgresHost: string | null;
  postgresPort: number | null;
  postgresDb: string | null;
  postgresUser: string | null;
  postgresPassword: string | null;
  mqttHost: string | null;
  mqttPort: number | null;
  mqttUsername: string | null;
  mqttPassword: string | null;
  mqttClientId: string | null;
  /** Default QoS for worker subscribe and command publish (Faz 0: at-least-once). */
  mqttQos: MqttQos;
  /** When false, broker keeps a persistent session for this clientId (Faz 0: durable delivery). */
  mqttCleanSession: boolean;
  /** Structured logger threshold; per-message firehose logs run at `debug`. */
  logLevel: LogLevel;
  simulatorMode: boolean;
  commandTopicMode: CommandTopicMode;
  /** Worker: seconds to wait for indicate/dev ACK before scheduling retry (field tuning). */
  commandAckTimeoutSec: number;
  /** Minimum extra delay (seconds) after ACK deadline before republish; avoids immediate 0s retry. */
  commandAckRetryMinDelaySec: number;
  /** Worker: seconds after ACK to wait for verify (switch/child refresh; ~telemetry cycle). */
  commandVerifyTimeoutSec: number;
  /** Fallback when policy_snapshot omits late_confirmation_window_sec (telemetry proof after delivery_timeout). */
  commandLateConfirmationWindowSec: number;
  /** Reconciler tick period (ms) for desired-state evaluation. */
  reconcileIntervalMs: number;
  /** Seconds of telemetry/presence freshness within which a device is considered online. */
  deviceOnlineTtlSec: number;
  /** Master switch for the desired-state reconciler loop. */
  reconcileEnabled: boolean;
  /**
   * EMQX shared-subscription group. When set, the worker subscribes via `$share/<group>/<topic>`
   * so multiple worker instances load-balance inbound traffic (horizontal scale). Empty = exclusive
   * subscription (single-instance behavior).
   */
  mqttSharedGroup: string | null;
  /** Max Postgres pool connections per process. Raise for high inbound fan-out at scale. */
  pgPoolMax: number;
  /**
   * Max inbound MQTT messages processed concurrently. Bounds the fan-out so a burst cannot
   * stampede the DB pool; excess messages queue in memory and drain as slots free up.
   */
  mqttInboundConcurrency: number;
  /** Max commands claimed/published per publish-loop tick (per worker). Scales outbound throughput. */
  publishBatchSize: number;
  /**
   * Wake-triggered delivery: when a device sends ANY inbound message it is provably online, so the
   * worker immediately flushes that device's claimable pending commands to hit its (often brief)
   * online window. Hugely improves delivery for sleepy/cellular devices that reconnect periodically.
   */
  wakeTriggeredPublishEnabled: boolean;
  /**
   * Presence gating for the periodic publish loop: only publish to devices whose last telemetry is
   * within this many seconds (i.e. currently awake). 0 disables gating (publish regardless). Pair
   * with wakeTriggeredPublishEnabled so fresh commands still go out the moment the device wakes.
   */
  publishRequireRecentTelemetrySec: number;
  /**
   * Derive switch_state from AdfState1 (bit 0x8000) when the device does not report SwitchSta.
   * Validated on Acrel prepaid meters. SwitchSta always wins when present.
   */
  switchDecodeFromAdfState: boolean;
  /**
   * Faz C: per-device adaptive timing. Learns each device's reconnect cadence from login events and
   * merges it into command timing (ack/retry/delivery-window/TTL) + reconciler backoff. The DB layer
   * reads ADAPTIVE_TIMING_ENABLED directly; this mirror is for boot logging/observability.
   */
  adaptiveTimingEnabled: boolean;
  /**
   * Faz C: per-device adaptive presence gating for the periodic publish loop. When true, the gating
   * window is derived from each device's learned reconnect cadence instead of the fixed
   * publishRequireRecentTelemetrySec. Removes the manual per-device knob.
   */
  adaptiveGatingEnabled: boolean;
}

export const appConfig: AppConfig = Object.freeze({
  nodeEnv: readString(process.env.NODE_ENV) ?? "development",
  apiPort: readNumber(process.env.API_PORT),
  postgresHost: readString(process.env.POSTGRES_HOST),
  postgresPort: readNumber(process.env.POSTGRES_PORT),
  postgresDb: readString(process.env.POSTGRES_DB),
  postgresUser: readString(process.env.POSTGRES_USER),
  postgresPassword: readString(process.env.POSTGRES_PASSWORD),
  mqttHost: readString(process.env.MQTT_HOST),
  mqttPort: readNumber(process.env.MQTT_PORT),
  mqttUsername: readString(process.env.MQTT_USERNAME),
  mqttPassword: readString(process.env.MQTT_PASSWORD),
  mqttClientId: readString(process.env.MQTT_CLIENT_ID),
  mqttQos: readMqttQos(process.env.MQTT_QOS, 1),
  mqttCleanSession: readBooleanWithDefault(process.env.MQTT_CLEAN_SESSION, false),
  logLevel: readLogLevel(process.env.LOG_LEVEL, "info"),
  simulatorMode: readBoolean(process.env.SIMULATOR_MODE),
  commandTopicMode: readCommandTopicMode(process.env.COMMAND_TOPIC_MODE),
  commandAckTimeoutSec: readPositiveInt(process.env.COMMAND_ACK_TIMEOUT_SEC, 20),
  commandAckRetryMinDelaySec: readNonNegativeInt(process.env.COMMAND_ACK_RETRY_MIN_DELAY_SEC, 5),
  commandVerifyTimeoutSec: readPositiveInt(process.env.COMMAND_VERIFY_TIMEOUT_SEC, 420),
  commandLateConfirmationWindowSec: readPositiveInt(process.env.COMMAND_LATE_CONFIRMATION_WINDOW_SEC, 3600),
  reconcileIntervalMs: readPositiveInt(process.env.RECONCILE_INTERVAL_MS, 5000),
  deviceOnlineTtlSec: readPositiveInt(process.env.DEVICE_ONLINE_TTL_SEC, 600),
  reconcileEnabled: readBooleanWithDefault(process.env.RECONCILE_ENABLED, true),
  mqttSharedGroup: readString(process.env.MQTT_SHARED_GROUP),
  pgPoolMax: readPositiveInt(process.env.PG_POOL_MAX, 20),
  mqttInboundConcurrency: readPositiveInt(process.env.MQTT_INBOUND_CONCURRENCY, 16),
  publishBatchSize: readPositiveInt(process.env.PUBLISH_BATCH_SIZE, 50),
  wakeTriggeredPublishEnabled: readBooleanWithDefault(process.env.WAKE_TRIGGERED_PUBLISH, true),
  publishRequireRecentTelemetrySec: readNonNegativeInt(process.env.PUBLISH_REQUIRE_TELEMETRY_SEC, 0),
  switchDecodeFromAdfState: readBooleanWithDefault(process.env.SWITCH_DECODE_FROM_ADFSTATE, true),
  adaptiveTimingEnabled: readBooleanWithDefault(process.env.ADAPTIVE_TIMING_ENABLED, true),
  adaptiveGatingEnabled: readBooleanWithDefault(process.env.ADAPTIVE_GATING_ENABLED, true)
});
