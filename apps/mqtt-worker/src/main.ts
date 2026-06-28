import { appConfig, createLogger, generateCommandMsgid } from "@communication/core";
import type { NormalizedIncomingMessage } from "@communication/contracts";
import { MqttDirection } from "@communication/contracts";
import {
  addCommandEvent,
  applyInboundDeviceAndLatestState,
  claimCommandsForPublish,
  countClaimableForPublish,
  createCommand,
  createDbPool,
  markCommandPublishAttempt,
  expireStaleScheduledCommands,
  getCommandById,
  findCommandForAck,
  findCommandDuplicateInboundAck,
  getLatestInboundUpdatePayloadBySn,
  findLatestVerifiedChildRefresh,
  listChildCommands,
  listPublishedCommandsPastAckDeadline,
  listRefreshCommandsPastVerifyDeadline,
  listRefreshCommandsWaitingVerification,
  listSwitchParentsPastVerifyDeadline,
  listSwitchParentsForLateConfirmation,
  findSwitchCommandsWaitingVerification,
  getLatestStateBySn,
  getDeviceBySn,
  insertRawMqttMessage,
  persistTelemetryFoundation,
  rescheduleCommandAfterAckTimeout,
  resolveInboundDevice,
  getReportedSwitchState,
  tryWithAdvisoryLock,
  ADVISORY_LOCK_KEYS,
  updateCommandStatus,
  upsertPresence,
  upsertClientBinding,
  resolveSnsForClientId,
  triggerReconcileForSn,
  evaluatePrepaidAutoCutoff,
  ADAPTIVE_GATING_FRACTION,
  ADAPTIVE_GATING_FLOOR_SEC,
  ADAPTIVE_GATING_CAP_SEC,
  CADENCE_MIN_SAMPLES
} from "@communication/db";
import type { CommandRow } from "@communication/db";
import {
  buildTopic,
  normalizeIncomingMessage,
  translateMe372BridgeMessage
} from "@communication/mqtt";
import mqtt, { type IClientOptions } from "mqtt";
import { buildMeterName } from "./meter-name.js";
import {
  correlateOperateAckWithCommand,
  isOperateAckResAccepted,
  isSubstantiveRefreshAckPayload,
  hasSubstantiveMeterForStandaloneRefreshVerify,
  getStandaloneMeterEvidencePath,
  evaluateParentSwitchVerification,
  extractSwitchStaFromPayload,
  parseCommandPolicySnapshot
} from "./command-lifecycle.js";
import { orchestrationMetrics } from "./orchestration-metrics.js";
import {
  commandObservabilityFields,
  logCommandLifecycle,
  logParentSwitchVerifyClosed,
  type ParentVerifySource
} from "./command-observability.js";
import { createSimulatorService } from "./simulator.js";
import { processDesiredStateReconciliation } from "./reconciler.js";
import { createWorkerHealthServer } from "./health-server.js";
import { createAlerter } from "./alerting.js";

const log = createLogger("mqtt-worker");

// Liveness state surfaced by the health/metrics HTTP server.
let mqttConnected = false;
let lastPublishLoopAt: number | null = null;
let lastReconcileLoopAt: number | null = null;

// Best-effort fault/alarm notifier (generic webhook; logs only when unconfigured).
const alerter = createAlerter({
  webhookUrl: appConfig.alertWebhookUrl,
  minIntervalSec: appConfig.alertMinIntervalSec,
  timeoutMs: appConfig.alertWebhookTimeoutMs,
  source: appConfig.mqttClientId ?? "mqtt-worker",
  log
});

const env = {
  nodeEnv: appConfig.nodeEnv,
  mqttHost: appConfig.mqttHost ?? "localhost",
  mqttPort: appConfig.mqttPort ?? 1883,
  clientId: appConfig.mqttClientId ?? "communication-worker",
  mqttUsername: appConfig.mqttUsername ?? undefined,
  mqttPassword: appConfig.mqttPassword ?? undefined
};

const brokerUrl = `${appConfig.mqttTls ? "mqtts" : "mqtt"}://${env.mqttHost}:${env.mqttPort}`;
const dbConfig = {
  host: appConfig.postgresHost ?? "127.0.0.1",
  port: appConfig.postgresPort ?? 5433,
  database: appConfig.postgresDb ?? "communication",
  user: appConfig.postgresUser ?? "postgres",
  password: appConfig.postgresPassword ?? "postgres",
  max: appConfig.pgPoolMax
};
// Subscribe to DEVICE->server topics only. The worker publishes commands to `sys/server/#` and
// `indicate/server/#`; subscribing to the broad `sys/#` / `indicate/#` would make the worker ingest
// its OWN outbound commands as if they were device telemetry/ACKs (corrupting reported state and
// causing false reconciliation). Devices report on `sys/dev/#`, `data/up/#`, `indicate/dev/#`.
const SUB_TOPICS = [
  "sys/dev/#",
  "data/up/#",
  "indicate/dev/#",
  "presence/#",
  "meta/#",
  // meter-bridge / Nano ESP32 IEC Mode C optical readers (translated to data/up before ingest)
  "energy/telemetry/+/+/up"
] as const;

/**
 * Actual subscribe filters. With MQTT_SHARED_GROUP set, wrap each topic as `$share/<group>/<topic>`
 * so EMQX load-balances inbound across worker instances (horizontal scale). EMQX delivers the real
 * topic to the handler, so downstream parsing is unaffected.
 */
const SUBSCRIBE_TOPICS: string[] = appConfig.mqttSharedGroup
  ? SUB_TOPICS.map((t) => `$share/${appConfig.mqttSharedGroup}/${t}`)
  : [...SUB_TOPICS];
/** Set true only after broker returns a non-empty, non-rejected SUBACK. */
let mqttSubscribeConfirmed = false;

const mqttOptions: IClientOptions = {
  clientId: env.clientId,
  reconnectPeriod: 3000,
  connectTimeout: 10_000,
  clean: appConfig.mqttCleanSession
};

if (appConfig.mqttTls) {
  // TLS transport (mqtts://). rejectUnauthorized=false only for self-signed certs during bring-up.
  mqttOptions.rejectUnauthorized = appConfig.mqttTlsRejectUnauthorized;
}

if (env.mqttUsername) {
  mqttOptions.username = env.mqttUsername;
}

if (env.mqttPassword) {
  mqttOptions.password = env.mqttPassword;
}

const client = mqtt.connect(brokerUrl, mqttOptions);
const dbPool = createDbPool(dbConfig);
const simulator = createSimulatorService();
let publishLoopActive = false;
let lastSubscribeNotReadyLogAt = 0;

const subscribeToCoreTopics = (): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    mqttSubscribeConfirmed = false;
    client.subscribe(SUBSCRIBE_TOPICS, { qos: appConfig.mqttQos }, (err, granted) => {
      console.log("[mqtt-worker] subscribe callback", {
        requested: SUBSCRIBE_TOPICS,
        err: err ? String(err) : null,
        granted
      });

      if (err) {
        console.error("[mqtt-worker] subscribe failed", {
          message: err instanceof Error ? err.message : String(err),
          requested: SUB_TOPICS
        });
        return reject(err);
      }

      if (Array.isArray(granted)) {
        const rejected = granted.filter((g) => g.qos === 128);
        if (rejected.length > 0) {
          const error = new Error(
            `MQTT subscription rejected: ${rejected.map((r) => r.topic).join(", ")}`
          );
          console.error("[mqtt-worker] subscribe failed", {
            message: error.message,
            requested: SUB_TOPICS,
            granted
          });
          return reject(error);
        }
      }

      if (!Array.isArray(granted) || granted.length === 0) {
        mqttSubscribeConfirmed = true;
        console.warn("[mqtt-worker] subscribe warning", {
          message: "empty granted list from broker; continuing in compatibility mode",
          requested: SUB_TOPICS
        });
        console.log("[mqtt-worker] subscriptions ready", {
          requested: SUB_TOPICS,
          granted: [],
          compatibilityMode: true
        });
        return resolve();
      }

      mqttSubscribeConfirmed = true;
      console.log("[mqtt-worker] subscriptions ready", {
        requested: SUB_TOPICS,
        granted: granted.map((g) => `${g.topic} qos=${g.qos}`)
      });
      resolve();
    });
  });

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const currentUnixSeconds = (): number => Math.floor(Date.now() / 1000);

const publishProtocolResponse = async (
  method: "login" | "time" | "topology",
  normalized: NormalizedIncomingMessage,
  payload: Record<string, unknown>
): Promise<void> => {
  const productKey = normalized.topic.deviceType;
  const deviceSn = normalized.topic.deviceId ?? normalized.sn;
  if (!productKey || !deviceSn) {
    console.warn("[mqtt-worker] protocol response skipped: missing productKey or sn from topic", {
      productKey,
      deviceSn,
      rawTopic: normalized.topic.raw
    });
    return;
  }

  const outboundTopic = buildTopic("sys", "server", productKey, deviceSn);
  const body = JSON.stringify(payload);
  console.log("[mqtt-worker] protocol response publishing", {
    outboundTopic,
    method,
    payloadJson: body
  });
  await new Promise<void>((resolve, reject) => {
    client.publish(outboundTopic, body, { qos: 0 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  const outMsgid = payload.msgid;
  const publishedLine =
    method === "login"
      ? "login response published"
      : method === "time"
        ? "time response published"
        : "topology response published";
  console.log(`[mqtt-worker] ${publishedLine}`, {
    outboundTopic,
    payloadJson: body,
    sn: deviceSn,
    msgid: outMsgid
  });
};

const readProtocolStringOrNumber = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return asNonEmptyString(value);
};

/**
 * Outbound msgid must mirror device payload (including numeric 0).
 */
const getOutboundMsgid = (normalized: NormalizedIncomingMessage): string | number | null => {
  const p = asObject(normalized.payloadJson);
  if (p && Object.prototype.hasOwnProperty.call(p, "msgid")) {
    const raw = p.msgid;
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }
  if (normalized.msgid != null && normalized.msgid !== "") {
    const s = normalized.msgid.trim();
    const asNum = Number(s);
    if (s !== "" && !Number.isNaN(asNum) && String(asNum) === s) {
      return asNum;
    }
    return s;
  }
  return null;
};

const hasOutboundMsgid = (normalized: NormalizedIncomingMessage): boolean =>
  getOutboundMsgid(normalized) !== null;

/** Same digits as device payload/topic; prefer topic deviceId if payload sn missing. */
const resolveHandshakeSn = (normalized: NormalizedIncomingMessage): string | null => {
  const p = asObject(normalized.payloadJson);
  if (p) {
    for (const key of ["sn", "SN", "Sn"]) {
      const v = readProtocolStringOrNumber(p[key]);
      if (v) {
        return v;
      }
    }
  }
  return asNonEmptyString(normalized.topic.deviceId) ?? asNonEmptyString(normalized.sn);
};

const resolveDeviceSendForTime = (
  payloadObj: Record<string, unknown> | null,
  fallback: string
): string => {
  if (!payloadObj) {
    return fallback;
  }
  for (const key of ["devicesend", "deviceSend", "DeviceSend"]) {
    const v = asNonEmptyString(payloadObj[key]);
    if (v) {
      return v;
    }
  }
  return fallback;
};

const isSysDevTopic = (normalized: NormalizedIncomingMessage): boolean => {
  const segs = normalized.topic.segments;
  if (segs.length < 4) {
    return false;
  }
  return segs[0]?.toLowerCase() === "sys" && segs[1]?.toLowerCase() === "dev";
};

const maybeHandleProtocolHandshake = async (normalized: NormalizedIncomingMessage): Promise<void> => {
  if (!isSysDevTopic(normalized)) {
    return;
  }

  const sn = resolveHandshakeSn(normalized);
  const methodRaw = normalized.method?.trim();
  const method = methodRaw ? methodRaw.toLowerCase() : null;
  const outboundMsgid = getOutboundMsgid(normalized);

  if (method === "login") {
    console.log("[mqtt-worker] login request received", {
      topic: normalized.topic.raw,
      sn,
      msgid: outboundMsgid
    });
  } else if (method === "time") {
    console.log("[mqtt-worker] time request received", {
      topic: normalized.topic.raw,
      sn,
      msgid: outboundMsgid
    });
  } else if (method === "topology") {
    console.log("[mqtt-worker] topology request received", {
      topic: normalized.topic.raw,
      sn,
      msgid: outboundMsgid
    });
  }

  if (!sn || !method || !hasOutboundMsgid(normalized)) {
    console.warn("[mqtt-worker] protocol handshake skipped: missing sn/msgid/method", {
      topic: normalized.topic.raw,
      sn,
      msgid: outboundMsgid,
      method: normalized.method,
      payloadKeys: normalized.payloadJson ? Object.keys(normalized.payloadJson) : []
    });
    return;
  }

  const nowUnix = currentUnixSeconds();
  const nowIso = new Date().toISOString();
  if (method === "login") {
    const msgidVal = getOutboundMsgid(normalized);
    const loginPayload: Record<string, unknown> = {
      msgid: msgidVal as string | number,
      method: "login",
      sn,
      res: 1,
      timestamp: nowUnix
    };
    console.log("[mqtt-worker] login response payload (outbound)", loginPayload);
    await publishProtocolResponse("login", normalized, loginPayload);
    return;
  }

  if (method === "time") {
    const payloadObj = asObject(normalized.payloadJson);
    const deviceSend = resolveDeviceSendForTime(payloadObj, normalized.timestamp ?? nowIso);
    const msgidVal = getOutboundMsgid(normalized);
    await publishProtocolResponse("time", normalized, {
      sn,
      method: "time",
      msgid: msgidVal as string | number,
      timezone: "UTC+03:00",
      timezoneMin: 180,
      devicesend: deviceSend,
      serverreceive: nowUnix,
      serversend: nowUnix,
      timestamp: nowUnix
    });
    return;
  }

  if (method === "topology") {
    const msgidVal = getOutboundMsgid(normalized);
    await publishProtocolResponse("topology", normalized, {
      sn,
      method: "topology",
      msgid: msgidVal as string | number,
      res: 1,
      timestamp: nowUnix
    });
  }
};

const getSwitchTarget = (command: CommandRow): number | null => {
  const payloadObj = asObject(command.request_payload);
  if (!payloadObj) {
    return null;
  }
  const raw = payloadObj.switchTarget;
  if (raw === 0 || raw === "0") {
    return 0;
  }
  if (raw === 1 || raw === "1") {
    return 1;
  }
  return null;
};

const getExpectedSwitchFromRequest = (command: CommandRow): number | null => {
  const payloadObj = asObject(command.request_payload);
  if (!payloadObj) {
    return null;
  }
  const raw = payloadObj.expectedSwitch;
  if (raw === 0 || raw === "0") {
    return 0;
  }
  if (raw === 1 || raw === "1") {
    return 1;
  }
  return null;
};

const unixSecondsNow = (): number => Math.floor(Date.now() / 1000);

/**
 * Device-doc outbound operate payload (indicate/server); wire JSON uses nested `payload`.
 * `meterName` is built per-device as "<project>-<model>-<sn>" by the caller and used for both
 * open (force_switch_1) and close (force_switch_0). Refresh does not use it.
 */
const buildOutboundCommandPayload = (
  command: CommandRow,
  meterName: string
): Record<string, unknown> => {
  const sn = command.sn;
  const ts = unixSecondsNow();
  const base = {
    method: "operate",
    msgid: command.msgid,
    sn,
    timestamp: ts
  };

  if (command.command_type === "refresh") {
    return {
      ...base,
      payload: {
        method: "REFRESH",
        addr: sn
      }
    };
  }

  const expected = command.command_type === "force_switch_1" ? 1 : 0;
  return {
    ...base,
    payload: {
      addr: sn,
      do1: expected,
      meterName,
      method: "FORCESWITCH",
      ForceSwitch: expected
    }
  };
};

const buildCommandOutboundTopic = (productKey: string, sn: string): string =>
  appConfig.commandTopicMode === "sys_server"
    ? buildTopic("sys", "server", productKey, sn)
    : buildTopic("indicate", "server", productKey, sn);

const getParseStatus = (normalized: NormalizedIncomingMessage): "parsed" | "parse_failed" =>
  normalized.payloadParseError ? "parse_failed" : "parsed";

const parsePresenceStatus = (topicSegments: string[], body: Record<string, unknown> | null): "online" | "offline" | null => {
  const sub = topicSegments[1]?.toLowerCase();
  if (sub === "connected") {
    return "online";
  }
  if (sub === "disconnected") {
    return "offline";
  }
  const ev = typeof body?.event === "string" ? body.event.toLowerCase() : null;
  if (ev === "client.connected" || ev === "connected") {
    return "online";
  }
  if (ev === "client.disconnected" || ev === "disconnected") {
    return "offline";
  }
  return null;
};

/**
 * Handles EMQX rule-engine output topics (presence + binding learning). Returns true when the
 * message was a control-plane message (so the caller skips device telemetry processing).
 * Independent of real clientid format: binds clientid<->sn from observed publish meta and resolves
 * presence to sn(s) via the binding table (gateway-aware). No-op when rules are not configured.
 */
const maybeHandlePresenceOrMeta = async (topic: string, payloadText: string): Promise<boolean> => {
  const segments = topic.split("/").filter((s) => s.length > 0);
  const channel = segments[0]?.toLowerCase();
  if (channel !== "presence" && channel !== "meta") {
    return false;
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(payloadText);
    body = asObject(parsed);
  } catch {
    body = null;
  }

  try {
    if (channel === "meta") {
      // EMQX message.publish republish: { clientid, topic }
      const clientid = asNonEmptyString(body?.clientid);
      const publishedTopic = asNonEmptyString(body?.topic);
      if (clientid && publishedTopic) {
        const parts = publishedTopic.split("/").filter((s) => s.length > 0);
        const productKey = parts[2] ?? null;
        const sn = parts[3] ?? null;
        if (sn) {
          await upsertClientBinding(dbPool, { clientid, productKey, sn });
          log.debug("client_binding_learned", { clientid, productKey, sn });
        }
      }
      return true;
    }

    // presence
    const status = parsePresenceStatus(segments, body);
    const clientid = asNonEmptyString(body?.clientid);
    if (clientid) {
      await upsertClientBinding(dbPool, { clientid });
    }
    if (!status) {
      log.warn("presence_event_unrecognized", { topic });
      return true;
    }

    const directSn = asNonEmptyString(body?.sn);
    let sns = directSn ? [directSn] : clientid ? await resolveSnsForClientId(dbPool, clientid) : [];
    // Fallback for fleets where clientid == sn (and binding not learned yet on first connect):
    // only adopt clientid as sn when a device row actually exists (avoids bogus presence rows).
    if (sns.length === 0 && clientid) {
      const device = await getDeviceBySn(dbPool, clientid);
      if (device) {
        sns = [clientid];
      }
    }
    for (const sn of sns) {
      await upsertPresence(dbPool, { sn, status, source: "mqtt_event" });
      if (status === "online") {
        await triggerReconcileForSn(dbPool, sn);
      }
    }
    log.info("presence_event", { topic, status, clientid, affectedSns: sns.length });
    return true;
  } catch (error) {
    log.error("presence_or_meta_handling_failed", {
      topic,
      message: error instanceof Error ? error.message : String(error)
    });
    return true;
  }
};

const processInboundMessage = async (topic: string, payloadText: string): Promise<void> => {
  const me372 = translateMe372BridgeMessage(
    topic,
    payloadText,
    appConfig.me372ProductKey,
    appConfig.me372Model
  );
  if (me372) {
    log.info("me372_bridge_translated", {
      fromTopic: topic,
      toTopic: me372.topic,
      meterId: me372.meterId,
      siteId: me372.siteId,
      bridgeDeviceId: me372.deviceId
    });
    topic = me372.topic;
    payloadText = me372.payloadText;
  }

  if (await maybeHandlePresenceOrMeta(topic, payloadText)) {
    return;
  }
  await logNormalizedMessage(topic, Buffer.from(payloadText, "utf8"));
};

const publishOneCommand = async (command: CommandRow): Promise<void> => {
  const topic = buildCommandOutboundTopic(command.product_key, command.sn);
  const device = await getDeviceBySn(dbPool, command.sn);
  const meterName = buildMeterName(device?.project_name ?? null, device?.model ?? null, command.sn);
  const payloadObj = buildOutboundCommandPayload(command, meterName);
  const payload = JSON.stringify(payloadObj);

  console.log("[mqtt-worker][command] publish_outbound", {
    msgid: command.msgid,
    commandId: command.id,
    sn: command.sn,
    commandType: command.command_type,
    commandTopicMode: appConfig.commandTopicMode,
    outboundTopic: topic,
    outboundPayloadJsonText: payload,
    publishedAt: command.published_at ?? null,
    ackTimeoutSec: appConfig.commandAckTimeoutSec
  });

  if (
    command.command_type === "force_switch_0" ||
    command.command_type === "force_switch_1" ||
    command.command_type === "refresh"
  ) {
    logCommandLifecycle(
      "publish_outbound",
      {
        ...commandObservabilityFields(command),
        topic,
        msgid: command.msgid,
        statusTransition: "claimed->publish_mqtt"
      },
      { method: "operate" }
    );
  }

  // Safety: in simulator mode, never hit the real broker (it may serve real devices). The
  // simulator below drives the full ACK/telemetry loop locally.
  if (!appConfig.simulatorMode) {
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, payload, { qos: appConfig.mqttQos }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  await markCommandPublishAttempt(dbPool, command.id);
  await addCommandEvent(dbPool, command.id, "published", {
    topic,
    payload: payloadObj
  });

  if (appConfig.simulatorMode) {
    console.log("[mqtt-worker] simulator intercepting outbound command", {
      topic,
      commandId: command.id,
      commandType: command.command_type
    });
    simulator.simulatePublishedCommand(topic, payloadObj, async (simulatedTopic, simulatedPayload) => {
      console.log("[mqtt-worker] simulator inbound message scheduled", {
        simulatedTopic,
        commandId: command.id
      });
      await processInboundMessage(simulatedTopic, simulatedPayload);
    });
  }
};

/** Publish a single claimed command (status already 'published' from the atomic claim). */
const publishClaimedCommand = async (command: CommandRow, nowIso: string): Promise<void> => {
  const due =
    command.next_attempt_at == null ||
    new Date(command.next_attempt_at).getTime() <= Date.now();
  const expiresAt = command.expires_at;
  const notExpired = expiresAt == null || new Date(expiresAt).getTime() > Date.now();
  console.log("[mqtt-worker][command] publish_claimed", {
    commandId: command.id,
    sn: command.sn,
    commandType: command.command_type,
    status: command.status,
    nextAttemptAt: command.next_attempt_at ?? null,
    now: nowIso,
    expiresAt: command.expires_at ?? null,
    due,
    notExpired,
    claimResult: "claimed",
    publishSkippedReason: null
  });
  try {
    const firstDeliveryAttempt = command.attempt_count === 1;
    await publishOneCommand(command);
    console.log("[mqtt-worker][command] status_transition", {
      commandId: command.id,
      sn: command.sn,
      commandType: command.command_type,
      phase: "publish_mqtt_ok",
      previousStatus: "scheduled",
      nextStatus: "published",
      publishedAt: "set_in_claim_transaction"
    });
    await updateCommandStatus(dbPool, command.id, "published");
    if (firstDeliveryAttempt) {
      const pol = parseCommandPolicySnapshot(command.policy_snapshot);
      await addCommandEvent(dbPool, command.id, "command_delivery_window_open", {
        deliveryWindowSec: pol.deliveryWindowSec,
        retryIntervalSec: pol.retryIntervalSec,
        ackTimeoutSec: pol.ackTimeoutSec
      });
    }
    if (
      command.command_type === "force_switch_0" ||
      command.command_type === "force_switch_1" ||
      command.command_type === "refresh"
    ) {
      const topic = buildCommandOutboundTopic(command.product_key, command.sn);
      logCommandLifecycle(
        "status_transition",
        {
          ...commandObservabilityFields(command),
          topic,
          msgid: command.msgid,
          previousStatus: "scheduled",
          nextStatus: "published"
        },
        { note: "persisted after mqtt publish" }
      );
    } else {
      console.log("[mqtt-worker] command published", {
        id: command.id,
        sn: command.sn,
        commandType: command.command_type
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown publish error";
    await updateCommandStatus(dbPool, command.id, "publish_failed", { errorMessage: message });
    await addCommandEvent(dbPool, command.id, "publish_failed", { message });
    if (
      command.command_type === "force_switch_0" ||
      command.command_type === "force_switch_1" ||
      command.command_type === "refresh"
    ) {
      logCommandLifecycle(
        "publish_failed",
        { ...commandObservabilityFields(command), nextStatus: "publish_failed" },
        { message }
      );
    } else {
      console.error("[mqtt-worker] command publish failed", {
        id: command.id,
        message
      });
    }
  }
};

/**
 * Wake-triggered delivery: a device that just sent ANY inbound message is provably online RIGHT
 * NOW, so flush its claimable pending commands immediately to hit its (often brief) online window.
 * Per-sn + atomic claim means this is safe to run alongside the periodic publish loop. Ignores the
 * periodic presence gate on purpose (we have direct proof of wakefulness).
 */
const flushPendingCommandsForSn = async (sn: string): Promise<void> => {
  if (!appConfig.wakeTriggeredPublishEnabled || !mqttSubscribeConfirmed) {
    return;
  }
  try {
    const claimed = await claimCommandsForPublish(dbPool, appConfig.publishBatchSize, { sn });
    if (claimed.length === 0) {
      return;
    }
    const nowIso = new Date().toISOString();
    console.log("[mqtt-worker][command] wake_triggered_flush", {
      sn,
      claimedCount: claimed.length,
      now: nowIso
    });
    for (const command of claimed) {
      await publishClaimedCommand(command, nowIso);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown wake flush error";
    console.error("[mqtt-worker][command] wake_triggered_flush_failed", { sn, message });
  }
};

const processPendingCommands = async (): Promise<void> => {
  try {
    const expiredRows = await expireStaleScheduledCommands(dbPool);
    if (expiredRows.length > 0) {
      console.log("[mqtt-worker][command] status_transition", {
        phase: "expire_scheduled_past_ttl",
        count: expiredRows.length,
        commandIds: expiredRows.map((r: CommandRow) => r.id),
        sns: expiredRows.map((r: CommandRow) => r.sn)
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown expire stale commands error";
    console.error("[mqtt-worker][command] expire_scheduled_past_ttl_failed", { message });
  }

  if (!mqttSubscribeConfirmed) {
    const nowMs = Date.now();
    if (nowMs - lastSubscribeNotReadyLogAt > 30_000) {
      lastSubscribeNotReadyLogAt = nowMs;
      console.warn("[mqtt-worker][command] publish_dispatcher_skipped", {
        publishSkippedReason: "mqtt_subscribe_not_confirmed",
        claimResult: "skipped",
        now: new Date().toISOString()
      });
    }
    return;
  }
  if (publishLoopActive) {
    return;
  }
  publishLoopActive = true;
  try {
    const nowIso = new Date().toISOString();
    const gateOpts = appConfig.adaptiveGatingEnabled
      ? {
          adaptiveGating: {
            fraction: ADAPTIVE_GATING_FRACTION,
            floorSec: ADAPTIVE_GATING_FLOOR_SEC,
            capSec: ADAPTIVE_GATING_CAP_SEC,
            minSamples: CADENCE_MIN_SAMPLES
          }
        }
      : { requireRecentTelemetrySec: appConfig.publishRequireRecentTelemetrySec || null };
    const pending = await claimCommandsForPublish(dbPool, appConfig.publishBatchSize, gateOpts);

    if (pending.length === 0) {
      // Only warn on GENUINE starvation: rows that pass the same first-per-sn + single-flight
      // filter as the claim query but were still not claimed. Commands legitimately waiting behind
      // an in-flight command for the same sn must NOT trigger a false "stuck" alarm. With presence
      // gating on, asleep devices are intentionally excluded so they do not false-alarm either.
      const claimableCount = await countClaimableForPublish(dbPool, gateOpts);
      if (claimableCount > 0) {
        console.warn("[mqtt-worker][command] publish_dispatcher_stuck_signal", {
          now: nowIso,
          claimableNotClaimedCount: claimableCount,
          claimResult: "empty",
          publishSkippedReason: "claimable_rows_exist_but_claim_returned_zero"
        });
      }
    }

    for (const command of pending) {
      await publishClaimedCommand(command, nowIso);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown command loop error";
    console.error("[mqtt-worker] command publish loop failed", { message });
  } finally {
    publishLoopActive = false;
  }
};

const expectedSwitchStaForParent = (parent: CommandRow): number | null => {
  if (parent.command_type === "force_switch_0") {
    return 0;
  }
  if (parent.command_type === "force_switch_1") {
    return 1;
  }
  return null;
};

const logVerifyTimeoutContext = async (
  cmd: CommandRow,
  segment: string,
  extra?: Record<string, unknown>
): Promise<void> => {
  const outboundTopic = buildCommandOutboundTopic(cmd.product_key, cmd.sn);
  let outboundPayload: Record<string, unknown>;
  try {
    const device = await getDeviceBySn(dbPool, cmd.sn);
    const meterName = buildMeterName(device?.project_name ?? null, device?.model ?? null, cmd.sn);
    outboundPayload = buildOutboundCommandPayload(cmd, meterName);
  } catch {
    outboundPayload = { error: "buildOutboundCommandPayload_failed" };
  }
  const latest = await getLatestStateBySn(dbPool, cmd.sn);
  let lastSummaryHint: unknown = null;
  if (latest?.last_summary && typeof latest.last_summary === "object") {
    const s = latest.last_summary as Record<string, unknown>;
    lastSummaryHint = s.reported ?? s;
  }
  console.log("[mqtt-worker][command] verify_timeout", {
    commandId: cmd.id,
    sn: cmd.sn,
    commandType: cmd.command_type,
    segment,
    outboundTopic,
    outboundPayload,
    publishedAt: cmd.published_at ?? null,
    ackAt: cmd.ack_at ?? null,
    hasAckPayload: cmd.ack_payload != null,
    latestStateLastMethod: latest?.last_method ?? null,
    latestStateLastTopic: latest?.last_topic ?? null,
    lastSummaryReportedHint: lastSummaryHint,
    ...extra
  });
};

/**
 * Mirrors `listRefreshCommandsPastVerifyDeadline`: window = GREATEST(verify_timeout, telemetry_cycle)
 * from policy snapshot, measured from this refresh row's `ack_at` (not the parent switch ack).
 */
const isRefreshCommandPastOwnVerifyDeadline = (
  cmd: CommandRow,
  defaultVerifyTimeoutSec: number
): boolean => {
  if (cmd.command_type !== "refresh" || cmd.ack_at == null) {
    return true;
  }
  const fallback = Math.max(1, Math.floor(defaultVerifyTimeoutSec));
  const pol = parseCommandPolicySnapshot(cmd.policy_snapshot);
  const vt = pol.verifyTimeoutSec > 0 ? pol.verifyTimeoutSec : fallback;
  const tc = pol.telemetryCycleSec ?? 0;
  const windowSec = Math.max(1, vt, tc);
  return Date.now() >= new Date(cmd.ack_at).getTime() + windowSec * 1000;
};

const DEVICE_ONLINE_MAX_AGE_MS = 3 * 60 * 1000;

const isDeviceRecentlyOnline = (lastSeenAt: string | null | undefined): boolean => {
  if (!lastSeenAt) {
    return false;
  }
  return Date.now() - new Date(lastSeenAt).getTime() <= DEVICE_ONLINE_MAX_AGE_MS;
};

const maybeEmitOnlineNoVerifyFault = async (cmd: CommandRow): Promise<void> => {
  const pol = parseCommandPolicySnapshot(cmd.policy_snapshot);
  if (!pol.raiseCommunicationFaultEnabled || !cmd.ack_at) {
    return;
  }
  const thresholdSec = pol.faultIfOnlineButNoVerifyAfterSec ?? pol.verifyTimeoutSec;
  const elapsedSec = (Date.now() - new Date(cmd.ack_at).getTime()) / 1000;
  if (elapsedSec + 1 < thresholdSec) {
    return;
  }
  const dev = await getDeviceBySn(dbPool, cmd.sn);
  if (!dev || !isDeviceRecentlyOnline(dev.last_seen_at)) {
    return;
  }
  await addCommandEvent(dbPool, cmd.id, "device_online_but_no_verify_fault", {
    sn: cmd.sn,
    ackAt: cmd.ack_at,
    thresholdSec
  });
  alerter.notify({
    type: "device_online_but_no_verify_fault",
    severity: "warning",
    sn: cmd.sn,
    message: `Device ${cmd.sn} online and ACKed command ${cmd.id} but did not verify within ${thresholdSec}s`,
    fields: { commandId: cmd.id, commandType: cmd.command_type, ackAt: cmd.ack_at, thresholdSec }
  });
};

const processCommandTimeouts = async (): Promise<void> => {
  try {
    await expireStaleScheduledCommands(dbPool);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown expire in timeout sweep";
    console.error("[mqtt-worker][command] expire_in_timeout_sweep_failed", { message });
  }

  try {
    const publishedOverdue = await listPublishedCommandsPastAckDeadline(
      dbPool,
      appConfig.commandAckTimeoutSec
    );
    for (const cmd of publishedOverdue) {
      const policy = parseCommandPolicySnapshot(cmd.policy_snapshot);
      const waitedMs =
        cmd.published_at != null
          ? Math.max(0, Date.now() - new Date(cmd.published_at).getTime())
          : null;
      const anchorMs = cmd.delivery_window_anchor_at
        ? new Date(cmd.delivery_window_anchor_at).getTime()
        : cmd.published_at
          ? new Date(cmd.published_at).getTime()
          : new Date(cmd.created_at).getTime();
      const deliveryWindowSec = Math.max(1, policy.deliveryWindowSec);
      const windowEndMs = anchorMs + deliveryWindowSec * 1000;
      const now = Date.now();

      console.log("[mqtt-worker][command] command_ack_timeout_wait_elapsed", {
        commandId: cmd.id,
        sn: cmd.sn,
        msgid: cmd.msgid,
        waitedMs,
        ackTimeoutSec: policy.ackTimeoutSec,
        attemptCount: cmd.attempt_count,
        deliveryWindowSec,
        deliveryWindowEndsAt: new Date(windowEndMs).toISOString()
      });

      if (now <= windowEndMs) {
        const intervalSec = Math.max(1, policy.retryIntervalSec);
        const minFloorSec = Math.max(policy.ackRetryMinDelaySec, appConfig.commandAckRetryMinDelaySec);
        const delayMs = Math.max(intervalSec * 1000, minFloorSec * 1000);
        const nextAt = new Date(now + delayMs);
        orchestrationMetrics.increment("ackTimeoutRetryScheduled");
        await rescheduleCommandAfterAckTimeout(dbPool, cmd.id, nextAt);
        await addCommandEvent(dbPool, cmd.id, "command_retry_scheduled", {
          nextAttemptInMs: delayMs,
          retryIntervalSec: intervalSec,
          deliveryWindowSec,
          deliveryWindowEndsAt: new Date(windowEndMs).toISOString(),
          attemptCount: cmd.attempt_count,
          anchorAt: new Date(anchorMs).toISOString()
        });
        await addCommandEvent(dbPool, cmd.id, "ack_timeout_retry", {
          nextAttemptInMs: delayMs,
          policyQuickRetryMs: intervalSec * 1000,
          minRetryDelaySec: minFloorSec,
          attemptCount: cmd.attempt_count
        });
        console.log("[mqtt-worker][command] command_retry_scheduled_detail", {
          commandId: cmd.id,
          sn: cmd.sn,
          waitedMs,
          retryIntervalSec: intervalSec,
          effectiveRetryDelayMs: delayMs,
          nextAttemptAt: nextAt.toISOString()
        });
        if (
          cmd.command_type === "force_switch_0" ||
          cmd.command_type === "force_switch_1" ||
          cmd.command_type === "refresh"
        ) {
          const after = await getCommandById(dbPool, cmd.id);
          logCommandLifecycle(
            "ack_timeout_retry_scheduled",
            {
              ...commandObservabilityFields(after ?? cmd),
              previousStatus: "published",
              nextStatus: "scheduled",
              nextAttemptAt: nextAt.toISOString()
            },
            {
              delayMs,
              retryIntervalSec: intervalSec,
              effectiveRetryDelayMs: delayMs,
              minRetryDelaySec: minFloorSec
            }
          );
        }
        continue;
      }

      await addCommandEvent(dbPool, cmd.id, "command_delivery_window_exhausted", {
        deliveryWindowSec,
        anchorAt: new Date(anchorMs).toISOString(),
        attemptCount: cmd.attempt_count
      });

      await updateCommandStatus(dbPool, cmd.id, "delivery_timeout", {
        errorMessage: "ack not received (delivery window exhausted)",
        completedAt: new Date()
      });
      orchestrationMetrics.increment("ackTimeoutDelivery");
      await addCommandEvent(dbPool, cmd.id, "delivery_timeout", {
        reason: "delivery_window_exhausted",
        attemptCount: cmd.attempt_count
      });

      if (policy.raiseCommunicationFaultEnabled) {
        const dev = await getDeviceBySn(dbPool, cmd.sn);
        if (dev && isDeviceRecentlyOnline(dev.last_seen_at)) {
          await addCommandEvent(dbPool, cmd.id, "device_online_but_no_ack_fault", {
            sn: cmd.sn,
            lastSeenAt: dev.last_seen_at,
            deliveryWindowSec,
            anchorAt: new Date(anchorMs).toISOString()
          });
          alerter.notify({
            type: "device_online_but_no_ack_fault",
            severity: "warning",
            sn: cmd.sn,
            message: `Device ${cmd.sn} seen online but command ${cmd.id} got no ACK within delivery window (${deliveryWindowSec}s)`,
            fields: { commandId: cmd.id, commandType: cmd.command_type, lastSeenAt: dev.last_seen_at, deliveryWindowSec }
          });
        }
      }

      if (
        cmd.command_type === "force_switch_0" ||
        cmd.command_type === "force_switch_1" ||
        cmd.command_type === "refresh"
      ) {
        const after = await getCommandById(dbPool, cmd.id);
        logCommandLifecycle(
          "delivery_timeout_ack",
          { ...commandObservabilityFields(after ?? cmd), previousStatus: "published", nextStatus: "delivery_timeout" },
          { reason: "delivery_window_exhausted" }
        );
      }
    }

    const refreshOverdue = await listRefreshCommandsPastVerifyDeadline(
      dbPool,
      appConfig.commandVerifyTimeoutSec
    );
    for (const cmd of refreshOverdue) {
      const latest = await getCommandById(dbPool, cmd.id);
      if (latest && (await tryRecoverRefreshVerifyFromEvidence(latest))) {
        orchestrationMetrics.increment("refreshVerifyRecoveredFromEvidence");
        continue;
      }

      await logVerifyTimeoutContext(cmd, "refresh_verify");
      console.log("[mqtt-worker][command] verify_timeout_waiting_update_cycle", {
        commandId: cmd.id,
        sn: cmd.sn,
        verifyTimeoutSec: appConfig.commandVerifyTimeoutSec,
        parentCommandId: cmd.parent_command_id ?? null,
        segment: cmd.parent_command_id ? "child_refresh" : "standalone_refresh"
      });

      if (cmd.parent_command_id) {
        const parentBefore = await getCommandById(dbPool, cmd.parent_command_id);
        if (
          parentBefore &&
          (await tryFinalizeParentWhenChildRefreshTimesOut(parentBefore, cmd))
        ) {
          await updateCommandStatus(dbPool, cmd.id, "failed", {
            errorMessage: "refresh verify_timeout (parent recovered from state evidence)",
            completedAt: new Date()
          });
          orchestrationMetrics.increment("refreshVerifyTimeout");
          await addCommandEvent(dbPool, cmd.id, "verify_timeout", { segment: "refresh" });
          await addCommandEvent(dbPool, cmd.id, "child_refresh_verify_failed_but_parent_recovered", {
            parentCommandId: cmd.parent_command_id
          });
          if (
            cmd.command_type === "force_switch_0" ||
            cmd.command_type === "force_switch_1" ||
            cmd.command_type === "refresh"
          ) {
            const after = await getCommandById(dbPool, cmd.id);
            logCommandLifecycle(
              "verify_timeout_refresh",
              { ...commandObservabilityFields(after ?? cmd), previousStatus: cmd.status, nextStatus: "failed" },
              { segment: "refresh", parentRecovered: true }
            );
          }
          continue;
        }
      }

      await updateCommandStatus(dbPool, cmd.id, "failed", {
        errorMessage: "refresh verify_timeout",
        completedAt: new Date()
      });
      orchestrationMetrics.increment("refreshVerifyTimeout");
      await addCommandEvent(dbPool, cmd.id, "verify_timeout", { segment: "refresh" });
      {
        const failedRefresh = await getCommandById(dbPool, cmd.id);
        if (failedRefresh) {
          await maybeEmitOnlineNoVerifyFault(failedRefresh);
        }
      }
      if (
        cmd.command_type === "force_switch_0" ||
        cmd.command_type === "force_switch_1" ||
        cmd.command_type === "refresh"
      ) {
        const after = await getCommandById(dbPool, cmd.id);
        logCommandLifecycle(
          "verify_timeout_refresh",
          { ...commandObservabilityFields(after ?? cmd), previousStatus: cmd.status, nextStatus: "failed" },
          { segment: "refresh" }
        );
      }
      if (cmd.parent_command_id) {
        const parentBefore = await getCommandById(dbPool, cmd.parent_command_id);
        await updateCommandStatus(dbPool, cmd.parent_command_id, "delivery_timeout", {
          errorMessage: "child refresh verify timeout",
          completedAt: new Date()
        });
        await addCommandEvent(dbPool, cmd.parent_command_id, "verify_timeout", {
          segment: "parent_after_refresh"
        });
        const parentAfter = await getCommandById(dbPool, cmd.parent_command_id);
        if (parentAfter && parentBefore) {
          const exp = expectedSwitchStaForParent(parentBefore);
          if (exp !== null) {
            logParentSwitchVerifyClosed(parentAfter, {
              verifySource: "timeout",
              expectedSwitch: exp,
              actualSwitch: null,
              finalStatus: "delivery_timeout"
            });
          }
        }
      }
    }

    const parentsOverdue = await listSwitchParentsPastVerifyDeadline(
      dbPool,
      appConfig.commandVerifyTimeoutSec
    );
    for (const parent of parentsOverdue) {
      let parentRow = await getCommandById(dbPool, parent.id);
      if (parentRow && (await tryFinalizeParentSwitchBeforeDeadline(parentRow))) {
        continue;
      }

      await tryVerifyRefreshCommandsFromLatestState(parent.sn);
      parentRow = await getCommandById(dbPool, parent.id);
      if (
        parentRow &&
        (parentRow.status === "verified_success" ||
          parentRow.status === "verified_success_with_late_confirmation")
      ) {
        continue;
      }

      const children = await listChildCommands(dbPool, parent.id);
      const verifyDefault = appConfig.commandVerifyTimeoutSec;
      const blockingRefresh = children.find(
        (c) =>
          c.command_type === "refresh" &&
          (c.status === "ack_received" || c.status === "verify_pending") &&
          c.ack_at != null &&
          !isRefreshCommandPastOwnVerifyDeadline(c, verifyDefault)
      );
      if (blockingRefresh) {
        const freshCh = await getCommandById(dbPool, blockingRefresh.id);
        if (freshCh && (await tryRecoverRefreshVerifyFromEvidence(freshCh))) {
          const pOk = await getCommandById(dbPool, parent.id);
          if (
            pOk &&
            (pOk.status === "verified_success" ||
              pOk.status === "verified_success_with_late_confirmation")
          ) {
            continue;
          }
        }
        console.log("[mqtt-worker][command] parent_verify_chain_deferred_child_refresh_sla", {
          parentCommandId: parent.id,
          childCommandId: blockingRefresh.id,
          parentAckAt: parent.ack_at,
          childAckAt: blockingRefresh.ack_at
        });
        continue;
      }

      await logVerifyTimeoutContext(parent, "parent_switch_verify", {
        childCommandCount: children.length
      });
      for (const ch of children) {
        if (
          ch.status === "published" ||
          ch.status === "scheduled" ||
          ch.status === "ack_received" ||
          ch.status === "verify_pending"
        ) {
          if (
            ch.command_type === "refresh" &&
            (ch.status === "ack_received" || ch.status === "verify_pending")
          ) {
            const freshR = await getCommandById(dbPool, ch.id);
            if (freshR && (await tryRecoverRefreshVerifyFromEvidence(freshR))) {
              const pCheck = await getCommandById(dbPool, parent.id);
              if (
                pCheck &&
                (pCheck.status === "verified_success" ||
                  pCheck.status === "verified_success_with_late_confirmation")
              ) {
                break;
              }
            }
            const pLate = await getCommandById(dbPool, parent.id);
            if (
              pLate &&
              freshR &&
              (await tryFinalizeParentWhenChildRefreshTimesOut(pLate, freshR))
            ) {
              await updateCommandStatus(dbPool, ch.id, "failed", {
                errorMessage: "verify chain timeout (parent recovered from state evidence)",
                completedAt: new Date()
              });
              await addCommandEvent(dbPool, ch.id, "child_refresh_verify_failed_but_parent_recovered", {
                parentCommandId: parent.id
              });
              const chRec = await getCommandById(dbPool, ch.id);
              logCommandLifecycle(
                "verify_timeout_child_failed",
                {
                  ...commandObservabilityFields(chRec ?? ch),
                  previousStatus: ch.status,
                  nextStatus: "failed",
                  parentCommandId: parent.id
                },
                { segment: "parent_verify_chain", parentRecovered: true }
              );
              break;
            }
          }
          await updateCommandStatus(dbPool, ch.id, "failed", {
            errorMessage: "verify chain timeout",
            completedAt: new Date()
          });
          if (
            ch.command_type === "force_switch_0" ||
            ch.command_type === "force_switch_1" ||
            ch.command_type === "refresh"
          ) {
            const chAfter = await getCommandById(dbPool, ch.id);
            logCommandLifecycle(
              "verify_timeout_child_failed",
              {
                ...commandObservabilityFields(chAfter ?? ch),
                previousStatus: ch.status,
                nextStatus: "failed",
                parentCommandId: parent.id
              },
              { segment: "parent_verify_chain" }
            );
          }
        }
      }

      const parentFinalCheck = await getCommandById(dbPool, parent.id);
      if (
        parentFinalCheck &&
        (parentFinalCheck.status === "verified_success" ||
          parentFinalCheck.status === "verified_success_with_late_confirmation")
      ) {
        continue;
      }
      if (parentFinalCheck?.status !== "verify_pending") {
        continue;
      }

      await addCommandEvent(dbPool, parent.id, "switch_verify_timeout_no_evidence", {
        sn: parent.sn,
        hadAck: parent.ack_at != null
      });
      await updateCommandStatus(dbPool, parent.id, "delivery_timeout", {
        errorMessage: "switch verify_timeout",
        completedAt: new Date()
      });
      orchestrationMetrics.increment("parentSwitchVerifyTimeout");
      await addCommandEvent(dbPool, parent.id, "verify_timeout", { segment: "parent" });
      const parentAfter = await getCommandById(dbPool, parent.id);
      if (parentAfter) {
        await maybeEmitOnlineNoVerifyFault(parentAfter);
      }
      const exp = expectedSwitchStaForParent(parent);
      if (parentAfter && exp !== null) {
        logParentSwitchVerifyClosed(parentAfter, {
          verifySource: "timeout",
          expectedSwitch: exp,
          actualSwitch: null,
          finalStatus: "delivery_timeout"
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown command timeout error";
    console.error("[mqtt-worker] processCommandTimeouts failed", { message });
  }
};

const createAutoRefreshCommand = async (parent: CommandRow): Promise<CommandRow | null> => {
  const pol = parseCommandPolicySnapshot(parent.policy_snapshot);
  if (!pol.autoRefreshAfterSwitchEnabled) {
    console.log("[mqtt-worker][command] auto_refresh_after_switch_skipped", {
      parentCommandId: parent.id,
      sn: parent.sn
    });
    return null;
  }
  const parentSwitch = getSwitchTarget(parent);
  const msgid = generateCommandMsgid();
  const requestPayload = {
    commandType: "refresh",
    expectedSwitch: parentSwitch,
    reason: "post_switch_verify"
  };

  const delayMs = pol.autoRefreshDelaySec * 1000;
  const scheduledAt = delayMs > 0 ? new Date(Date.now() + delayMs) : new Date();

  const refreshCommand = await createCommand(dbPool, {
    sn: parent.sn,
    productKey: parent.product_key,
    commandType: "refresh",
    method: "operate",
    msgid,
    parentCommandId: parent.id,
    requestPayload,
    scheduledAt,
    policySnapshot: parent.policy_snapshot
  });
  await addCommandEvent(dbPool, refreshCommand.id, "created", {
    reason: "auto_refresh_after_switch",
    parentCommandId: parent.id
  });
  logCommandLifecycle(
    "child_refresh_created",
    { ...commandObservabilityFields(refreshCommand), parentCommandId: parent.id },
    { msgid, scheduledAt: scheduledAt.toISOString(), autoRefreshDelaySec: pol.autoRefreshDelaySec }
  );
  return refreshCommand;
};

const resolveSwitchStaFromLatestState = async (
  sn: string
): Promise<number | null> => {
  const latestState = await getLatestStateBySn(dbPool, sn);
  if (!latestState) {
    return null;
  }
  const fromSummary = extractSwitchStaFromPayload(latestState.last_summary);
  if (fromSummary !== null && Number.isFinite(fromSummary)) {
    return fromSummary;
  }
  const fromPayload = extractSwitchStaFromPayload(latestState.last_payload);
  if (fromPayload !== null && Number.isFinite(fromPayload)) {
    return fromPayload;
  }
  // Fallback for meters that never send SwitchSta: the typed switch_state column is populated from
  // the AdfState1 bit-15 decode in telemetry-foundation, so verification still has a switch signal.
  const typed = await getReportedSwitchState(dbPool, sn);
  if (typed !== null && Number.isFinite(typed)) {
    return typed;
  }
  return null;
};

/**
 * Reconcile success signal: prefer the typed telemetry-foundation column (authoritative for the
 * device-reported switch position), fall back to latest_state JSON extraction.
 */
const resolveReportedSwitchForReconcile = async (sn: string): Promise<number | null> => {
  const typed = await getReportedSwitchState(dbPool, sn);
  if (typed !== null) {
    return typed;
  }
  return resolveSwitchStaFromLatestState(sn);
};

const bumpRefreshVerifiedMetrics = async (commandId: string): Promise<void> => {
  orchestrationMetrics.increment("verifySuccess");
  const row = await getCommandById(dbPool, commandId);
  const vMs =
    row?.published_at != null
      ? Math.max(0, Date.now() - new Date(row.published_at).getTime())
      : null;
  orchestrationMetrics.recordVerifyLatencyMs(vMs);
};

const tryLateConfirmSwitchParentsForSn = async (sn: string, actualSwitch: number): Promise<void> => {
  if (!Number.isFinite(actualSwitch)) {
    return;
  }
  const parents = await listSwitchParentsForLateConfirmation(
    dbPool,
    sn,
    appConfig.commandLateConfirmationWindowSec
  );
  for (const parent of parents) {
    const pol = parseCommandPolicySnapshot(parent.policy_snapshot);
    if (!pol.parentLateSuccessEnabled) {
      continue;
    }
    const outcome = evaluateParentSwitchVerification(parent.command_type, actualSwitch);
    if (!outcome || outcome.status !== "verified_success") {
      continue;
    }
    await updateCommandStatus(dbPool, parent.id, "verified_success_with_late_confirmation", {
      verificationPayload: {
        verifySource: "late_telemetry",
        expectedSwitch: outcome.expectedSwitch,
        actualSwitch: outcome.actualSwitch,
        priorStatus: "delivery_timeout"
      },
      errorMessage: null
    });
    await addCommandEvent(dbPool, parent.id, "late_switch_confirmation", {
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch,
      priorStatus: "delivery_timeout"
    });
    await addCommandEvent(dbPool, parent.id, "parent_verified_with_late_confirmation", {
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch,
      priorStatus: "delivery_timeout",
      via: "late_telemetry"
    });
    console.log("[mqtt-worker][command] verified_success_with_late_confirmation", {
      commandId: parent.id,
      sn,
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch,
      priorStatus: "delivery_timeout"
    });
    orchestrationMetrics.increment("lateConfirmation");
    const refreshedParent = await getCommandById(dbPool, parent.id);
    if (refreshedParent) {
      const vMs =
        refreshedParent.published_at != null
          ? Math.max(0, Date.now() - new Date(refreshedParent.published_at).getTime())
          : null;
      orchestrationMetrics.recordVerifyLatencyMs(vMs);
      logParentSwitchVerifyClosed(refreshedParent, {
        verifySource: "late_telemetry",
        expectedSwitch: outcome.expectedSwitch,
        actualSwitch: outcome.actualSwitch,
        finalStatus: "verified_success_with_late_confirmation"
      });
    }
    console.log("[mqtt-worker][command] orchestration_metric_increment", {
      metric: "late_confirmation_count",
      commandId: parent.id,
      sn
    });
    logCommandLifecycle(
      "late_switch_confirmed_from_telemetry",
      {
        commandId: parent.id,
        sn,
        expectedSwitch: outcome.expectedSwitch,
        actualSwitch: outcome.actualSwitch
      },
      { priorStatus: "delivery_timeout" }
    );
  }
};

const verifyParentSwitchCommand = async (
  parentCommandId: string,
  options?: {
    verifySource?: ParentVerifySource;
    actualSwitchHint?: number | null;
  }
): Promise<void> => {
  const parent = await getCommandById(dbPool, parentCommandId);
  if (!parent) {
    return;
  }
  if (parent.command_type !== "force_switch_0" && parent.command_type !== "force_switch_1") {
    return;
  }

  const terminal = new Set<CommandRow["status"]>([
    "verified_success",
    "verified_success_with_late_confirmation",
    "verified_mismatch"
  ]);
  if (terminal.has(parent.status)) {
    return;
  }

  const policy = parseCommandPolicySnapshot(parent.policy_snapshot);
  let eligibility: "normal" | "late" | null = null;
  if (parent.status === "ack_received" || parent.status === "verify_pending") {
    eligibility = "normal";
  } else if (parent.status === "delivery_timeout" && parent.completed_at) {
    const completed = new Date(parent.completed_at).getTime();
    if (Date.now() - completed <= policy.lateConfirmationWindowSec * 1000) {
      eligibility = "late";
    }
  }
  if (eligibility === null) {
    return;
  }

  const polParent = parseCommandPolicySnapshot(parent.policy_snapshot);
  const verifySource: ParentVerifySource = options?.verifySource ?? "latest_state_update";
  if (
    (verifySource === "child_refresh" || verifySource === "child_substantive_ack") &&
    !polParent.parentFinalizeFromChildRefresh
  ) {
    console.log("[mqtt-worker][command] parent_finalize_from_child_refresh_disabled", {
      parentCommandId: parent.id,
      sn: parent.sn
    });
    return;
  }

  let actualSwitch: number | null;
  if (
    options?.actualSwitchHint !== undefined &&
    options.actualSwitchHint !== null &&
    Number.isFinite(options.actualSwitchHint)
  ) {
    actualSwitch = options.actualSwitchHint;
  } else {
    actualSwitch = await resolveSwitchStaFromLatestState(parent.sn);
  }

  if (actualSwitch === null) {
    console.warn("[mqtt-worker][command] parent_switch_verify_skipped", {
      ...commandObservabilityFields(parent),
      verifySource,
      reason: "SwitchSta unavailable"
    });
    return;
  }

  const outcome = evaluateParentSwitchVerification(parent.command_type, actualSwitch);
  if (!outcome) {
    return;
  }

  const successStatus: CommandRow["status"] =
    outcome.status === "verified_success"
      ? eligibility === "late"
        ? "verified_success_with_late_confirmation"
        : "verified_success"
      : "verified_mismatch";

  const finalStatus = successStatus;
  await updateCommandStatus(dbPool, parent.id, finalStatus, {
    verificationPayload: {
      verifySource,
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch,
      eligibility
    },
    errorMessage: outcome.status === "verified_success" ? null : "switch state mismatch"
  });
  await addCommandEvent(dbPool, parent.id, finalStatus, {
    expectedSwitch: outcome.expectedSwitch,
    actualSwitch: outcome.actualSwitch,
    verifySource,
    eligibility
  });

  if (
    (verifySource === "child_refresh" || verifySource === "child_substantive_ack") &&
    finalStatus === "verified_success"
  ) {
    await addCommandEvent(dbPool, parent.id, "parent_verified_from_child_refresh", {
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch,
      via: verifySource
    });
    logCommandLifecycle(
      "parent_verified_from_child_refresh",
      {
        ...commandObservabilityFields({ ...parent, status: finalStatus }),
        expectedSwitch: outcome.expectedSwitch,
        actualSwitch: outcome.actualSwitch
      },
      { verifySource }
    );
  }

  if (verifySource === "latest_state_update" && outcome.status === "verified_success") {
    await addCommandEvent(dbPool, parent.id, "parent_verified_from_update_cycle", {
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch
    });
  }

  if (outcome.status === "verified_success") {
    orchestrationMetrics.increment("verifySuccess");
    const after = await getCommandById(dbPool, parent.id);
    const vMs =
      after?.published_at != null
        ? Math.max(0, Date.now() - new Date(after.published_at).getTime())
        : null;
    orchestrationMetrics.recordVerifyLatencyMs(vMs);
  } else {
    orchestrationMetrics.increment("verifyMismatchOrFail");
  }

  const refreshedParent = await getCommandById(dbPool, parent.id);
  logParentSwitchVerifyClosed(refreshedParent ?? parent, {
    verifySource,
    expectedSwitch: outcome.expectedSwitch,
    actualSwitch: outcome.actualSwitch,
    finalStatus
  });
};

/**
 * Highest-precedence verify path for refresh: SwitchSta embedded in indicate ACK payload.
 * Returns true if the refresh command reached a terminal verify state from this payload.
 */
const tryCompleteRefreshVerifyFromAck = async (
  command: CommandRow,
  ackPayload: unknown,
  source: "refresh_ack_payload"
): Promise<boolean> => {
  if (command.command_type !== "refresh") {
    return false;
  }
  const expectedSwitch = resolveExpectedSwitchFromCommand(command);
  const actualFromAck = extractSwitchStaFromPayload(ackPayload);
  if (expectedSwitch === null || actualFromAck === null || !Number.isFinite(actualFromAck)) {
    return false;
  }

  if (actualFromAck === expectedSwitch) {
    await updateCommandStatus(dbPool, command.id, "verified_success", {
      verificationPayload: {
        source,
        expectedSwitch,
        actualSwitch: actualFromAck
      }
    });
    await addCommandEvent(dbPool, command.id, "verified_success", {
      source,
      expectedSwitch,
      actualSwitch: actualFromAck
    });
    await bumpRefreshVerifiedMetrics(command.id);
    logCommandLifecycle(
      "refresh_verified_from_ack",
      {
        ...commandObservabilityFields({ ...command, status: "verified_success" }),
        parentCommandId: command.parent_command_id
      },
      { expectedSwitch, actualSwitch: actualFromAck }
    );
    if (command.parent_command_id) {
      await verifyParentSwitchCommand(command.parent_command_id, {
        verifySource: "refresh_ack",
        actualSwitchHint: actualFromAck
      });
    }
    return true;
  }

  await updateCommandStatus(dbPool, command.id, "verified_mismatch", {
    verificationPayload: {
      source,
      expectedSwitch,
      actualSwitch: actualFromAck
    },
    errorMessage: "switch state mismatch (refresh ack)"
  });
  await addCommandEvent(dbPool, command.id, "verified_mismatch", {
    expectedSwitch,
    actualSwitch: actualFromAck,
    source
  });
  if (command.parent_command_id) {
    await verifyParentSwitchCommand(command.parent_command_id, {
      verifySource: "refresh_ack",
      actualSwitchHint: actualFromAck
    });
  }
  return true;
};

/**
 * Standalone + child refresh: device ACK with res=1 and substantive meter `payload`
 * can close verify without waiting for data/up `update`. Parent switch is finalized from hint.
 */
const tryCompleteRefreshVerifyFromSubstantiveAck = async (
  command: CommandRow,
  ackPayload: unknown
): Promise<boolean> => {
  if (command.command_type !== "refresh") {
    return false;
  }
  if (!isSubstantiveRefreshAckPayload(ackPayload)) {
    return false;
  }
  const standalone = command.parent_command_id == null;
  await updateCommandStatus(dbPool, command.id, "verified_success", {
    verificationPayload: {
      source: standalone ? "refresh_ack_payload_meters" : "refresh_ack_payload_meters_child",
      standalone
    },
    errorMessage: null
  });
  await addCommandEvent(dbPool, command.id, "verified_success", {
    source: standalone ? "refresh_ack_payload_meters" : "refresh_ack_payload_meters_child",
    standalone
  });
  await bumpRefreshVerifiedMetrics(command.id);
  const row = await getCommandById(dbPool, command.id);
  logCommandLifecycle(
    "refresh_verified_from_ack_payload",
    {
      ...(row ? commandObservabilityFields(row) : commandObservabilityFields({ ...command, status: "verified_success" })),
      parentCommandId: command.parent_command_id
    },
    { sn: command.sn, segment: standalone ? "standalone_refresh" : "child_refresh" }
  );
  console.log("[mqtt-worker][command] refresh_verified_from_ack_payload", {
    commandId: command.id,
    sn: command.sn,
    msgid: command.msgid,
    segment: standalone ? "standalone_refresh" : "child_refresh"
  });
  if (command.parent_command_id) {
    const hint =
      extractSwitchStaFromPayload(ackPayload) ?? (await resolveSwitchStaFromLatestState(command.sn));
    await verifyParentSwitchCommand(command.parent_command_id, {
      verifySource: "child_substantive_ack",
      actualSwitchHint: hint
    });
  }
  return true;
};

const hasReportedSummary = (summary: unknown): boolean => {
  const summaryObj = asObject(summary);
  if (!summaryObj) {
    return false;
  }
  return asObject(summaryObj.reported) !== null;
};

const resolveExpectedSwitchFromCommand = (command: CommandRow): number | null => {
  if (command.command_type === "force_switch_0") {
    return 0;
  }
  if (command.command_type === "force_switch_1") {
    return 1;
  }
  return getExpectedSwitchFromRequest(command);
};

type RefreshVerifyFromStateContext = {
  /** Current message body when handling `method === "update"` (preferred over DB snapshot). */
  inboundUpdatePayload?: unknown;
};

const resolveStandaloneMeterEvidence = async (
  sn: string,
  latestState: Awaited<ReturnType<typeof getLatestStateBySn>>,
  ctx?: RefreshVerifyFromStateContext
): Promise<{
  ok: boolean;
  verifySource: string | null;
  evidencePath: string | null;
}> => {
  const tryPayload = (p: unknown): boolean =>
    p != null && hasSubstantiveMeterForStandaloneRefreshVerify(p);

  if (ctx?.inboundUpdatePayload != null && tryPayload(ctx.inboundUpdatePayload)) {
    return {
      ok: true,
      verifySource: "inbound_update_payload",
      evidencePath: getStandaloneMeterEvidencePath(ctx.inboundUpdatePayload, "inbound_update_payload")
    };
  }
  if (latestState?.last_payload != null && tryPayload(latestState.last_payload)) {
    return {
      ok: true,
      verifySource: "latest_state.last_payload",
      evidencePath: getStandaloneMeterEvidencePath(latestState.last_payload, "latest_state.last_payload")
    };
  }
  if (latestState?.last_summary != null && tryPayload(latestState.last_summary)) {
    return {
      ok: true,
      verifySource: "latest_state.last_summary",
      evidencePath: getStandaloneMeterEvidencePath(latestState.last_summary, "latest_state.last_summary")
    };
  }
  const rawUpdate = await getLatestInboundUpdatePayloadBySn(dbPool, sn);
  if (rawUpdate != null && tryPayload(rawUpdate)) {
    return {
      ok: true,
      verifySource: "raw_mqtt_inbound_update",
      evidencePath: getStandaloneMeterEvidencePath(rawUpdate, "raw_mqtt_inbound_update")
    };
  }
  return { ok: false, verifySource: null, evidencePath: null };
};

const tryVerifyRefreshCommandsFromLatestState = async (
  sn: string,
  ctx?: RefreshVerifyFromStateContext
): Promise<void> => {
  const waitingRefreshes = await listRefreshCommandsWaitingVerification(dbPool, sn);
  if (waitingRefreshes.length === 0) {
    return;
  }

  const latestState = await getLatestStateBySn(dbPool, sn);
  const standaloneWaits = waitingRefreshes.filter((r) => r.parent_command_id == null);
  const childWaits = waitingRefreshes.filter((r) => r.parent_command_id != null);

  const standaloneEvidence =
    standaloneWaits.length > 0
      ? await resolveStandaloneMeterEvidence(sn, latestState, ctx)
      : {
          ok: false as boolean,
          verifySource: null as string | null,
          evidencePath: null as string | null
        };

  const standaloneUpdateReady =
    latestState !== null &&
    latestState.last_method === "update" &&
    standaloneEvidence.ok;

  if (standaloneWaits.length > 0) {
    if (!standaloneUpdateReady) {
      for (const refresh of standaloneWaits) {
        await addCommandEvent(dbPool, refresh.id, "waiting_verification", {
          required: ["standalone_data_up_meter_fields"],
          observedLastMethod: latestState?.last_method ?? null,
          hasSubstantiveMeterFromInbound: ctx?.inboundUpdatePayload
            ? hasSubstantiveMeterForStandaloneRefreshVerify(ctx.inboundUpdatePayload)
            : false,
          hasSubstantiveMeterFromPayload: latestState
            ? hasSubstantiveMeterForStandaloneRefreshVerify(latestState.last_payload)
            : false,
          hasSubstantiveMeterFromSummary: latestState
            ? hasSubstantiveMeterForStandaloneRefreshVerify(latestState.last_summary)
            : false
        });
        console.log("[mqtt-worker] waiting for update verification (standalone)", {
          commandId: refresh.id,
          sn,
          observedLastMethod: latestState?.last_method ?? null
        });
      }
    } else {
      const verificationPayloadStandalone = {
        source: "latest_state_update_standalone_meters",
        verifySource: standaloneEvidence.verifySource,
        evidencePath: standaloneEvidence.evidencePath,
        lastTimestamp: latestState!.last_timestamp ?? null,
        lastMethod: latestState!.last_method ?? null,
        lastTopic: latestState!.last_topic ?? null,
        lastSummary: latestState!.last_summary ?? null
      };
      for (const refresh of standaloneWaits) {
        await updateCommandStatus(dbPool, refresh.id, "verified_success", {
          verificationPayload: {
            ...verificationPayloadStandalone,
            expectedSwitch: null,
            actualSwitch: null
          },
          errorMessage: null
        });
        await addCommandEvent(dbPool, refresh.id, "verified_success", {
          ...verificationPayloadStandalone,
          expectedSwitch: null,
          actualSwitch: null
        });
        await bumpRefreshVerifiedMetrics(refresh.id);
        const row = await getCommandById(dbPool, refresh.id);
        logCommandLifecycle(
          "refresh_verified_from_update_payload",
          {
            ...(row ? commandObservabilityFields(row) : commandObservabilityFields({ ...refresh, status: "verified_success" })),
            parentCommandId: null
          },
          { sn, verifySource: standaloneEvidence.verifySource, evidencePath: standaloneEvidence.evidencePath }
        );
        console.log("[mqtt-worker][command] refresh_verified_from_update_payload", {
          commandId: refresh.id,
          sn,
          verifySource: standaloneEvidence.verifySource,
          evidencePath: standaloneEvidence.evidencePath
        });
        console.log("[mqtt-worker][command] verify_confirmed_from_update_cycle", {
          commandId: refresh.id,
          sn,
          segment: "standalone_refresh",
          verifySource: standaloneEvidence.verifySource,
          evidencePath: standaloneEvidence.evidencePath
        });
      }
    }
  }

  if (childWaits.length === 0) {
    return;
  }

  const actualSwitchFromLatestSnapshot = await resolveSwitchStaFromLatestState(sn);

  const childStrictReportedReady =
    latestState !== null &&
    latestState.last_method === "update" &&
    hasReportedSummary(latestState.last_summary);

  const verificationPayloadBase = {
    source: "latest_state_update" as const,
    lastTimestamp: latestState?.last_timestamp ?? null,
    lastMethod: latestState?.last_method ?? null,
    lastTopic: latestState?.last_topic ?? null,
    lastSummary: latestState?.last_summary ?? null
  };

  let reportedSwitchFromDataUp: number = NaN;
  if (childStrictReportedReady && latestState) {
    const summaryObj = asObject(latestState.last_summary);
    const reported = asObject(summaryObj?.reported);
    const switchRaw = reported?.SwitchSta;
    reportedSwitchFromDataUp =
      typeof switchRaw === "number"
        ? switchRaw
        : typeof switchRaw === "string"
          ? Number(switchRaw)
          : NaN;
  }

  for (const refresh of childWaits) {
    const expectedSwitch = resolveExpectedSwitchFromCommand(refresh);

    if (
      expectedSwitch !== null &&
      actualSwitchFromLatestSnapshot !== null &&
      Number.isFinite(actualSwitchFromLatestSnapshot) &&
      actualSwitchFromLatestSnapshot === expectedSwitch
    ) {
      const verificationPayload = {
        ...verificationPayloadBase,
        verifyPath: "switch_state_evidence",
        expectedSwitch,
        actualSwitch: actualSwitchFromLatestSnapshot
      };
      await updateCommandStatus(dbPool, refresh.id, "verified_success", {
        verificationPayload,
        errorMessage: null
      });
      await addCommandEvent(dbPool, refresh.id, "verified_success", verificationPayload);
      await bumpRefreshVerifiedMetrics(refresh.id);
      logCommandLifecycle(
        "refresh_verified_from_latest_state",
        {
          ...commandObservabilityFields({ ...refresh, status: "verified_success" }),
          parentCommandId: refresh.parent_command_id
        },
        {
          expectedSwitch,
          actualSwitch: actualSwitchFromLatestSnapshot,
          sn,
          verifyPath: "switch_state_evidence"
        }
      );
      console.log("[mqtt-worker][command] verify_confirmed_from_update_cycle", {
        commandId: refresh.id,
        sn,
        segment: "child_refresh",
        verifyPath: "switch_state_evidence",
        expectedSwitch,
        actualSwitch: actualSwitchFromLatestSnapshot
      });
      if (refresh.parent_command_id) {
        await verifyParentSwitchCommand(refresh.parent_command_id, {
          verifySource: "child_refresh",
          actualSwitchHint: actualSwitchFromLatestSnapshot
        });
      }
      continue;
    }

    if (!childStrictReportedReady) {
      await addCommandEvent(dbPool, refresh.id, "waiting_verification", {
        required: ["switch_evidence_or_update_reported"],
        observedLastMethod: latestState?.last_method ?? null,
        hasReported: latestState ? hasReportedSummary(latestState.last_summary) : false,
        actualSwitchFromLatestSnapshot
      });
      console.log("[mqtt-worker] waiting for update verification", {
        commandId: refresh.id,
        sn,
        observedLastMethod: latestState?.last_method ?? null
      });
      continue;
    }

    const actualSwitch = reportedSwitchFromDataUp;

    if (
      expectedSwitch !== null &&
      Number.isFinite(actualSwitch) &&
      actualSwitch !== expectedSwitch
    ) {
      await updateCommandStatus(dbPool, refresh.id, "verified_mismatch", {
        verificationPayload: {
          ...verificationPayloadBase,
          verifyPath: "data_up_reported_switch",
          source: "latest_state_update",
          expectedSwitch,
          actualSwitch
        },
        errorMessage: "switch state mismatch (data/up update)"
      });
      await addCommandEvent(dbPool, refresh.id, "verified_mismatch", {
        ...verificationPayloadBase,
        expectedSwitch,
        actualSwitch
      });
      if (refresh.parent_command_id) {
        await verifyParentSwitchCommand(refresh.parent_command_id, {
          verifySource: "child_refresh",
          actualSwitchHint: actualSwitch
        });
      }
      logCommandLifecycle(
        "refresh_verified_mismatch_from_latest_state",
        {
          ...commandObservabilityFields({ ...refresh, status: "verified_mismatch" }),
          parentCommandId: refresh.parent_command_id
        },
        { expectedSwitch, actualSwitch, sn }
      );
      continue;
    }
    if (expectedSwitch !== null && !Number.isFinite(actualSwitch)) {
      await addCommandEvent(dbPool, refresh.id, "waiting_verification", {
        required: ["reported.SwitchSta matches expectedSwitch"],
        expectedSwitch,
        actualSwitch: null
      });
      console.log("[mqtt-worker] waiting for update verification", {
        commandId: refresh.id,
        sn,
        expectedSwitch,
        actualSwitch: null
      });
      continue;
    }

    await updateCommandStatus(dbPool, refresh.id, "verified_success", {
      verificationPayload: {
        ...verificationPayloadBase,
        verifyPath: "data_up_reported_switch",
        expectedSwitch,
        actualSwitch: Number.isFinite(actualSwitch) ? actualSwitch : null
      },
      errorMessage: null
    });
    await addCommandEvent(dbPool, refresh.id, "verified_success", {
      ...verificationPayloadBase,
      expectedSwitch,
      actualSwitch: Number.isFinite(actualSwitch) ? actualSwitch : null
    });
    await bumpRefreshVerifiedMetrics(refresh.id);
    logCommandLifecycle(
      "refresh_verified_from_latest_state",
      {
        ...commandObservabilityFields({ ...refresh, status: "verified_success" }),
        parentCommandId: refresh.parent_command_id
      },
      {
        expectedSwitch,
        actualSwitch: Number.isFinite(actualSwitch) ? actualSwitch : null,
        sn
      }
    );
    console.log("[mqtt-worker][command] verify_confirmed_from_update_cycle", {
      commandId: refresh.id,
      sn,
      segment: "child_refresh",
      expectedSwitch,
      actualSwitch: Number.isFinite(actualSwitch) ? actualSwitch : null
    });
    if (refresh.parent_command_id) {
      await verifyParentSwitchCommand(refresh.parent_command_id, {
        verifySource: "child_refresh",
        actualSwitchHint: Number.isFinite(actualSwitch) ? actualSwitch : null
      });
    }
  }
};

const tryRecoverRefreshVerifyFromEvidence = async (cmd: CommandRow): Promise<boolean> => {
  if (cmd.command_type !== "refresh") {
    return false;
  }
  if (cmd.status !== "ack_received" && cmd.status !== "verify_pending") {
    return false;
  }
  const fresh = await getCommandById(dbPool, cmd.id);
  if (!fresh) {
    return false;
  }
  const ackPayload = fresh.ack_payload ?? null;

  if (await tryCompleteRefreshVerifyFromAck(fresh, ackPayload, "refresh_ack_payload")) {
    await addCommandEvent(dbPool, fresh.id, "recovery_refresh_timeout", { path: "ack_switchsta" });
    return true;
  }
  if (ackPayload !== null && (await tryCompleteRefreshVerifyFromSubstantiveAck(fresh, ackPayload))) {
    await addCommandEvent(dbPool, fresh.id, "recovery_refresh_timeout", { path: "ack_substantive" });
    return true;
  }

  const expected = resolveExpectedSwitchFromCommand(fresh);
  const actual = await resolveSwitchStaFromLatestState(fresh.sn);
  if (expected !== null && actual !== null && actual === expected) {
    await updateCommandStatus(dbPool, fresh.id, "verified_success", {
      verificationPayload: {
        source: "recovery_refresh_timeout_switch_evidence",
        expectedSwitch: expected,
        actualSwitch: actual
      },
      errorMessage: null
    });
    await addCommandEvent(dbPool, fresh.id, "verified_success", {
      source: "recovery_refresh_timeout_switch_evidence"
    });
    await bumpRefreshVerifiedMetrics(fresh.id);
    if (fresh.parent_command_id) {
      await verifyParentSwitchCommand(fresh.parent_command_id, {
        verifySource: "recovery_refresh_timeout",
        actualSwitchHint: actual
      });
    }
    logCommandLifecycle(
      "refresh_recovered_at_timeout_from_evidence",
      { ...commandObservabilityFields({ ...fresh, status: "verified_success" }), parentCommandId: fresh.parent_command_id },
      { path: "latest_state_switch" }
    );
    return true;
  }
  return false;
};

const tryFinalizeParentWhenChildRefreshTimesOut = async (
  parent: CommandRow,
  childCmd: CommandRow
): Promise<boolean> => {
  if (parent.command_type !== "force_switch_0" && parent.command_type !== "force_switch_1") {
    return false;
  }
  if (parent.status !== "verify_pending") {
    return false;
  }
  if (!parent.ack_at) {
    return false;
  }
  const pol = parseCommandPolicySnapshot(parent.policy_snapshot);
  if (!pol.parentLateSuccessEnabled) {
    return false;
  }
  const actual = await resolveSwitchStaFromLatestState(parent.sn);
  const outcome = evaluateParentSwitchVerification(parent.command_type, actual);
  if (!outcome || outcome.status !== "verified_success") {
    return false;
  }
  await updateCommandStatus(dbPool, parent.id, "verified_success_with_late_confirmation", {
    verificationPayload: {
      verifySource: "recovery_after_child_timeout",
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch,
      childCommandId: childCmd.id
    },
    errorMessage: null
  });
  await addCommandEvent(dbPool, parent.id, "parent_verified_with_late_confirmation", {
    expectedSwitch: outcome.expectedSwitch,
    actualSwitch: outcome.actualSwitch,
    childCommandId: childCmd.id,
    reason: "child_refresh_verify_timeout_state_evidence"
  });
  const refreshed = await getCommandById(dbPool, parent.id);
  if (refreshed) {
    logParentSwitchVerifyClosed(refreshed, {
      verifySource: "recovery_after_child_timeout",
      expectedSwitch: outcome.expectedSwitch,
      actualSwitch: outcome.actualSwitch,
      finalStatus: "verified_success_with_late_confirmation"
    });
  }
  return true;
};

const tryFinalizeParentSwitchBeforeDeadline = async (parent: CommandRow): Promise<boolean> => {
  if (parent.command_type !== "force_switch_0" && parent.command_type !== "force_switch_1") {
    return false;
  }
  if (parent.status !== "verify_pending") {
    return false;
  }
  await verifyParentSwitchCommand(parent.id, { verifySource: "latest_state_update" });
  const after = await getCommandById(dbPool, parent.id);
  if (
    after &&
    (after.status === "verified_success" || after.status === "verified_success_with_late_confirmation")
  ) {
    await addCommandEvent(dbPool, parent.id, "recovery_parent_deadline_evidence", {
      finalStatus: after.status
    });
    return true;
  }
  return false;
};

const maybeHandleCommandAckAndVerify = async (
  normalized: NormalizedIncomingMessage
): Promise<void> => {
  const resolved = resolveInboundDevice(normalized);
  if (!resolved) {
    return;
  }

  if (normalized.topic.channel === "indicate" && normalized.msgid && normalized.method) {
    const inboundTopic = normalized.topic.raw;
    const payloadJson = normalized.payloadJson ?? { raw: normalized.payloadText };
    const dirSeg = normalized.topic.segments[1]?.toLowerCase() ?? "";

    if (dirSeg === "server") {
      console.log("[mqtt-worker][command] inbound_ack_candidate", {
        commandId: null,
        inboundTopic,
        payloadJson,
        ackAccepted: false,
        rejectReason: "server_originated_indicate_not_device_ack"
      });
      console.log("[mqtt-worker][command] ack_rejected", {
        inboundTopic,
        payloadJson,
        rejectReason: "server_originated_indicate_not_device_ack"
      });
      return;
    }

    if (dirSeg !== "dev") {
      console.log("[mqtt-worker][command] inbound_ack_candidate", {
        commandId: null,
        inboundTopic,
        payloadJson,
        ackAccepted: false,
        rejectReason: "indicate_topic_must_be_indicate_dev_for_ack"
      });
      console.log("[mqtt-worker][command] ack_rejected", {
        inboundTopic,
        payloadJson,
        rejectReason: "indicate_topic_must_be_indicate_dev_for_ack"
      });
      return;
    }

    const command = await findCommandForAck(
      dbPool,
      resolved.sn,
      normalized.msgid,
      normalized.method
    );

    if (!command) {
      const duplicate = await findCommandDuplicateInboundAck(
        dbPool,
        resolved.sn,
        normalized.msgid,
        normalized.method
      );
      if (duplicate) {
        const dupPub = duplicate.published_at != null ? new Date(duplicate.published_at).getTime() : null;
        const duplicateAckLatencyMs =
          dupPub != null ? Math.max(0, Date.now() - dupPub) : null;
        console.log("[mqtt-worker][command] duplicate_ack_ignored", {
          commandId: duplicate.id,
          sn: resolved.sn,
          msgid: normalized.msgid,
          method: normalized.method,
          commandStatus: duplicate.status,
          inboundTopic,
          duplicateAckLatencyMs
        });
        return;
      }
      console.log("[mqtt-worker][command] inbound_ack_candidate", {
        commandId: null,
        inboundTopic,
        payloadJson,
        ackAccepted: false,
        rejectReason: "no_matching_published_command"
      });
      console.log("[mqtt-worker][command] ack_rejected", {
        inboundTopic,
        payloadJson,
        rejectReason: "no_matching_published_command"
      });
      console.warn("[mqtt-worker] command ack match not found", {
        sn: resolved.sn,
        msgid: normalized.msgid,
        method: normalized.method
      });
      return;
    }

    if (
      normalized.topic.deviceType !== command.product_key ||
      normalized.topic.deviceId !== command.sn
    ) {
      const rejectReason = "topic_product_key_or_sn_mismatch";
      console.log("[mqtt-worker][command] inbound_ack_candidate", {
        commandId: command.id,
        inboundTopic,
        payloadJson,
        ackAccepted: false,
        rejectReason
      });
      console.log("[mqtt-worker][command] ack_rejected", {
        inboundTopic,
        payloadJson,
        rejectReason,
        commandId: command.id,
        topicDeviceType: normalized.topic.deviceType,
        topicDeviceId: normalized.topic.deviceId,
        commandProductKey: command.product_key,
        commandSn: command.sn
      });
      return;
    }

    if (!isOperateAckResAccepted(payloadJson)) {
      const rejectReason = "ack_res_not_1";
      console.log("[mqtt-worker][command] inbound_ack_candidate", {
        commandId: command.id,
        inboundTopic,
        payloadJson,
        ackAccepted: false,
        rejectReason
      });
      console.log("[mqtt-worker][command] ack_rejected", {
        inboundTopic,
        payloadJson,
        rejectReason,
        commandId: command.id
      });
      return;
    }

    const corr = correlateOperateAckWithCommand(command.command_type, payloadJson);
    if (!corr.ok) {
      console.log("[mqtt-worker][command] inbound_ack_candidate", {
        commandId: command.id,
        inboundTopic,
        payloadJson,
        ackAccepted: false,
        rejectReason: corr.reason
      });
      console.log("[mqtt-worker][command] ack_rejected", {
        inboundTopic,
        payloadJson,
        rejectReason: corr.reason,
        commandId: command.id
      });
      return;
    }

    console.log("[mqtt-worker][command] inbound_ack_candidate", {
      commandId: command.id,
      inboundTopic,
      payloadJson,
      ackAccepted: true,
      rejectReason: null
    });

    const ackPayloadStored = payloadJson;
    const ackLatencyMs =
      command.published_at != null
        ? Math.max(0, Date.now() - new Date(command.published_at).getTime())
        : null;
    console.log("[mqtt-worker][command] command_ack_latency", {
      commandId: command.id,
      sn: command.sn,
      msgid: command.msgid,
      ackLatencyMs,
      publishedAt: command.published_at ?? null
    });
    console.log("[mqtt-worker][command] ack_accepted", {
      commandId: command.id,
      inboundTopic,
      payloadJson,
      matchedBy:
        "topic_indicate_dev+sn+msgid+method+product_route+res_1+payload_or_operate_optional",
      ackLatencyMs
    });

    await updateCommandStatus(dbPool, command.id, "ack_received", {
      ackPayload: ackPayloadStored
    });
    await addCommandEvent(dbPool, command.id, "ack_received", {
      topic: normalized.topic.raw
    });
    console.log("[mqtt-worker][command] delivery_confirmed_from_device_ack", {
      commandId: command.id,
      sn: command.sn,
      commandType: command.command_type,
      msgid: command.msgid
    });
    orchestrationMetrics.increment("ackInboundAccepted");
    orchestrationMetrics.recordAckLatencyMs(ackLatencyMs);
    if (
      command.command_type === "force_switch_0" ||
      command.command_type === "force_switch_1" ||
      command.command_type === "refresh"
    ) {
      logCommandLifecycle(
        "status_transition",
        {
          ...commandObservabilityFields({ ...command, status: "ack_received" }),
          topic: normalized.topic.raw,
          msgid: command.msgid,
          previousStatus: "published",
          nextStatus: "ack_received"
        },
        { inboundTopic: normalized.topic.raw }
      );
    } else {
      console.log("[mqtt-worker] command ack received", {
        commandId: command.id,
        commandType: command.command_type
      });
    }

    if (command.command_type === "force_switch_0" || command.command_type === "force_switch_1") {
      await createAutoRefreshCommand(command);
      await updateCommandStatus(dbPool, command.id, "verify_pending", {});
      const parentRow = await getCommandById(dbPool, command.id);
      if (parentRow) {
        logCommandLifecycle(
          "status_transition",
          {
            ...commandObservabilityFields(parentRow),
            topic: normalized.topic.raw,
            msgid: command.msgid,
            previousStatus: "ack_received",
            nextStatus: "verify_pending"
          },
          { phase: "switch_parent_awaits_child_verify" }
        );
      }
    }

    if (command.command_type === "refresh") {
      await updateCommandStatus(dbPool, command.id, "verify_pending", {});
      const refreshRow = await getCommandById(dbPool, command.id);
      if (refreshRow) {
        logCommandLifecycle(
          "status_transition",
          {
            ...commandObservabilityFields(refreshRow),
            topic: normalized.topic.raw,
            msgid: command.msgid,
            previousStatus: "ack_received",
            nextStatus: "verify_pending"
          },
          {
            phase: refreshRow.parent_command_id
              ? "refresh_child_awaits_verify"
              : "refresh_standalone_awaits_verify"
          }
        );
      }
      const completedFromSwitchSta = await tryCompleteRefreshVerifyFromAck(
        command,
        ackPayloadStored,
        "refresh_ack_payload"
      );
      let refreshVerifyTerminal = completedFromSwitchSta;
      if (!refreshVerifyTerminal) {
        refreshVerifyTerminal = await tryCompleteRefreshVerifyFromSubstantiveAck(
          command,
          ackPayloadStored
        );
      }
      if (!refreshVerifyTerminal) {
        await addCommandEvent(dbPool, command.id, "waiting_verification", {
          required: ["latest_state.last_method=update", "latest_state.summary.reported"],
          reason: "ack_payload_has_no_switchsta"
        });
        const row = await getCommandById(dbPool, command.id);
        logCommandLifecycle(
          "refresh_waiting_latest_state_update",
          {
            ...(row ? commandObservabilityFields(row) : commandObservabilityFields(command)),
            parentCommandId: command.parent_command_id
          },
          { sn: resolved.sn }
        );
        await tryVerifyRefreshCommandsFromLatestState(resolved.sn);
      }
    }
  }

  if (normalized.method === "update") {
    logCommandLifecycle(
      "data_up_update_for_verify",
      { sn: resolved.sn, productKey: resolved.productKey },
      { topic: normalized.topic.raw }
    );
    await tryVerifyRefreshCommandsFromLatestState(resolved.sn, {
      inboundUpdatePayload: normalized.payloadJson ?? undefined
    });

    const reportedSwitchRaw = normalized.reportedSummary?.SwitchSta;
    const reportedSwitch =
      typeof reportedSwitchRaw === "number"
        ? reportedSwitchRaw
        : typeof reportedSwitchRaw === "string"
          ? Number(reportedSwitchRaw)
          : NaN;
    // Prefer device-sent SwitchSta; otherwise fall back to the decoded switch position (AdfState1
    // bit-15 -> typed switch_state column) so meters that never report SwitchSta still confirm.
    const actualSwitch = Number.isFinite(reportedSwitch)
      ? reportedSwitch
      : await resolveSwitchStaFromLatestState(resolved.sn);

    if (actualSwitch !== null && Number.isFinite(actualSwitch)) {
      await tryLateConfirmSwitchParentsForSn(resolved.sn, actualSwitch);

      const waitingParents = await findSwitchCommandsWaitingVerification(dbPool, resolved.sn);
      for (const parent of waitingParents) {
        const childRefresh = await findLatestVerifiedChildRefresh(dbPool, parent.id);
        if (!childRefresh) {
          continue;
        }
        await verifyParentSwitchCommand(parent.id, { verifySource: "latest_state_update" });
      }
    }
  }
};

const persistRawMessage = async (
  normalized: NormalizedIncomingMessage,
  receivedAt: Date
): Promise<void> => {
  const parseStatus = getParseStatus(normalized);
  const payloadForStorage: unknown = normalized.payloadJson ?? { raw: normalized.payloadText };

  await insertRawMqttMessage(dbPool, {
    direction: MqttDirection.Inbound,
    topic: normalized.topic.raw,
    deviceSn: normalized.sn ?? normalized.topic.deviceId,
    productKey: normalized.topic.deviceType,
    protocolMsgid: normalized.msgid,
    method: normalized.method,
    payload: payloadForStorage,
    receivedAt,
    parseStatus,
    parseError: normalized.payloadParseError
  });
};

const logNormalizedMessage = async (topic: string, payload: Buffer): Promise<void> => {
  const receivedAt = new Date();
  const normalized: NormalizedIncomingMessage = normalizeIncomingMessage(topic, payload);
  const parseStatus = getParseStatus(normalized);

  if (normalized.payloadParseError) {
    console.warn("[mqtt-worker] payload parse warning", {
      topic,
      parseError: normalized.payloadParseError
    });
  }

  log.debug("telemetry inbound", {
    topic,
    sn: normalized.sn,
    method: normalized.method,
    msgid: normalized.msgid,
    parseStatus
  });

  // Wake-triggered delivery FIRST: a device that just spoke is online for only a brief window
  // (this Acrel family wakes ~a few seconds every ~90s). Publish its claimable commands with
  // minimal latency — BEFORE raw/telemetry persistence — so we hit that window. flushPending
  // CommandsForSn bypasses presence gating (we have direct proof of wakefulness) and is a no-op
  // when nothing is claimable, so this stays cheap for the common case.
  const wakeDevice = resolveInboundDevice(normalized);
  if (wakeDevice) {
    await flushPendingCommandsForSn(wakeDevice.sn);
  }

  try {
    await persistRawMessage(normalized, receivedAt);
    log.debug("raw saved", {
      topic: normalized.topic.raw,
      sn: normalized.sn,
      method: normalized.method,
      msgid: normalized.msgid,
      parseStatus
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown db write error";
    console.error("[mqtt-worker] failed to persist raw message", {
      topic: normalized.topic.raw,
      message
    });
    return;
  }

  try {
    await persistTelemetryFoundation(dbPool, {
      normalized,
      receivedAt,
      parseStatus,
      deriveSwitchFromAdfState: appConfig.switchDecodeFromAdfState
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown telemetry foundation error";
    console.error("[mqtt-worker] telemetry foundation persist failed", {
      topic: normalized.topic.raw,
      sn: normalized.sn,
      message
    });
  }

  try {
    await maybeHandleProtocolHandshake(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown protocol handshake error";
    console.error("[mqtt-worker] protocol handshake handling failed", { message });
  }

  const resolved = resolveInboundDevice(normalized);
  if (!resolved) {
    console.warn("[mqtt-worker] skip device/latest_state: missing device sn", {
      topic: normalized.topic.raw
    });
    return;
  }

  try {
    await applyInboundDeviceAndLatestState(dbPool, normalized, receivedAt, {
      whitelistEnabled: appConfig.deviceWhitelistEnabled
    });
    log.debug("device upserted", {
      sn: resolved.sn,
      productKey: resolved.productKey
    });
    log.debug("latest_state updated", {
      sn: resolved.sn,
      method: normalized.method,
      msgid: normalized.msgid
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown db upsert error";
    console.error("[mqtt-worker] failed to upsert device/latest_state", {
      sn: resolved.sn,
      message
    });
  }

  if (normalized.method?.toLowerCase() === "update") {
    try {
      const cut = await evaluatePrepaidAutoCutoff(dbPool, resolved.sn);
      if (cut) {
        log.info("prepaid_auto_cutoff_triggered", { sn: resolved.sn });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "prepaid cutoff error";
      console.error("[mqtt-worker] prepaid auto cutoff failed", { sn: resolved.sn, message });
    }
  }

  // Telemetry-driven reconcile: wake the reconciler for this sn immediately instead of waiting out
  // the backoff window. Done unconditionally on any inbound message (not just SwitchSta-bearing
  // updates) because devices that never report SwitchSta still confirm via AdfState1-derived state.
  // triggerReconcileForSn is a no-op for sns without an active desired state, so this stays cheap.
  try {
    await triggerReconcileForSn(dbPool, resolved.sn);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown reconcile trigger error";
    console.error("[mqtt-worker] telemetry reconcile trigger failed", {
      sn: resolved.sn,
      message
    });
  }

  try {
    await maybeHandleCommandAckAndVerify(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown command ack/verify error";
    console.error("[mqtt-worker] command lifecycle handling failed", { message });
  }
};

console.log("[mqtt-worker] worker booted", {
  nodeEnv: env.nodeEnv,
  mqttHost: env.mqttHost,
  mqttPort: env.mqttPort,
  clientId: env.clientId,
  mqttQos: appConfig.mqttQos,
  mqttCleanSession: appConfig.mqttCleanSession,
  logLevel: appConfig.logLevel,
  simulatorMode: appConfig.simulatorMode,
  commandAckTimeoutSec: appConfig.commandAckTimeoutSec,
  commandAckRetryMinDelaySec: appConfig.commandAckRetryMinDelaySec,
  commandVerifyTimeoutSec: appConfig.commandVerifyTimeoutSec,
  commandLateConfirmationWindowSec: appConfig.commandLateConfirmationWindowSec,
  wakeTriggeredPublishEnabled: appConfig.wakeTriggeredPublishEnabled,
  publishRequireRecentTelemetrySec: appConfig.publishRequireRecentTelemetrySec,
  switchDecodeFromAdfState: appConfig.switchDecodeFromAdfState,
  adaptiveTimingEnabled: appConfig.adaptiveTimingEnabled,
  adaptiveGatingEnabled: appConfig.adaptiveGatingEnabled,
  workerHealthPort: appConfig.workerHealthPort,
  alertingEnabled: appConfig.alertWebhookUrl !== null
});

const metricsInterval = setInterval(() => {
  orchestrationMetrics.emitSnapshot();
}, 120_000);
if (typeof metricsInterval === "object" && metricsInterval !== null && "unref" in metricsInterval) {
  (metricsInterval as NodeJS.Timeout).unref();
}

console.log("[mqtt-worker] postgres connection starting", {
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user
});

dbPool
  .query("SELECT 1")
  .then(() => {
    console.log("[mqtt-worker] postgres connection ready");
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown postgres error";
    console.error("[mqtt-worker] postgres connection error", { message });
  });

client.on("connect", (packet) => {
  mqttConnected = true;
  console.log("[mqtt-worker] connected", {
    brokerUrl,
    sessionPresent: packet.sessionPresent
  });
  void (async () => {
    try {
      await subscribeToCoreTopics();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[mqtt-worker] fatal: MQTT subscribe did not complete", { message });
      process.exit(1);
    }
    void processPendingCommands();
  })();
});

client.on("reconnect", () => {
  console.warn("[mqtt-worker] reconnecting", { brokerUrl });
});

client.on("offline", () => {
  mqttConnected = false;
  console.warn("[mqtt-worker] offline");
});

client.on("close", () => {
  mqttConnected = false;
  console.warn("[mqtt-worker] connection closed");
});

client.on("end", () => {
  mqttConnected = false;
  console.warn("[mqtt-worker] client ended");
});

client.on("error", (error) => {
  console.error("[mqtt-worker] connection error", {
    message: error.message
  });
});

client.on("disconnect", (packet) => {
  console.warn("[mqtt-worker] broker requested disconnect", {
    reasonCode: packet.reasonCode,
    properties: packet.properties ?? null
  });
});

// Bounded inbound dispatcher: cap concurrent message processing so a broker burst (e.g. hundreds of
// ACK/telemetry messages arriving at once) cannot stampede the DB pool. Excess messages queue in
// memory and drain as slots free up. Backpressure is observable via the queue-depth warning.
const inboundQueue: Array<{ topic: string; payloadText: string }> = [];
let inboundActive = 0;
let lastQueueWarnAt = 0;

const pumpInboundQueue = (): void => {
  while (inboundActive < appConfig.mqttInboundConcurrency && inboundQueue.length > 0) {
    const next = inboundQueue.shift();
    if (!next) {
      break;
    }
    inboundActive += 1;
    void processInboundMessage(next.topic, next.payloadText)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown inbound processing error";
        console.error("[mqtt-worker] inbound_processing_failed", { topic: next.topic, message });
      })
      .finally(() => {
        inboundActive -= 1;
        pumpInboundQueue();
      });
  }
};

client.on("message", (topic, payload) => {
  log.debug("rx", {
    topic,
    bytes: payload.length,
    payload: payload.toString()
  });
  inboundQueue.push({ topic, payloadText: payload.toString("utf8") });
  if (inboundQueue.length > appConfig.mqttInboundConcurrency * 50) {
    const now = Date.now();
    if (now - lastQueueWarnAt > 5000) {
      lastQueueWarnAt = now;
      console.warn("[mqtt-worker] inbound_queue_backpressure", {
        queueDepth: inboundQueue.length,
        activeWorkers: inboundActive,
        concurrency: appConfig.mqttInboundConcurrency
      });
    }
  }
  pumpInboundQueue();
});

setInterval(() => {
  lastPublishLoopAt = Date.now();
  void processPendingCommands();
  // Timeout/expiry sweep is global bookkeeping: run single-flight across instances via advisory
  // lock (publish claim + reconciler lease remain parallel for throughput). A transient DB blip
  // (e.g. connection timeout while acquiring the lock connection) must NOT crash the worker.
  void tryWithAdvisoryLock(dbPool, ADVISORY_LOCK_KEYS.commandTimeoutSweep, () =>
    processCommandTimeouts()
  ).catch((error: unknown) => {
    console.error("[mqtt-worker][command] timeout_sweep_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
}, 1500);

let reconcileLoopActive = false;
const reconcilerConfig = {
  onlineTtlSec: appConfig.deviceOnlineTtlSec,
  defaultMinBackoffSec: 30,
  defaultMaxBackoffSec: 300,
  defaultUnreachableAlarmSec: 1800,
  jitterPct: 20,
  onlineRetryIntervalSec: appConfig.reconcileOnlineRetrySec,
  offlineAlarmEnabled: appConfig.reconcileOfflineAlarmEnabled,
  // Bounded 3-cycle switch model fallbacks (per-device policy profile overrides these).
  cycleCount: 3,
  signalsPerCycle: 10,
  cycleIntervalsSec: [10, 10, 7]
};
setInterval(() => {
  if (!appConfig.reconcileEnabled || reconcileLoopActive) {
    return;
  }
  reconcileLoopActive = true;
  void processDesiredStateReconciliation({
    pool: dbPool,
    log,
    resolveReportedSwitch: resolveReportedSwitchForReconcile,
    config: reconcilerConfig,
    onUnreachableAlarm: ({ sn, desired, unreachableForSec }) => {
      alerter.notify({
        type: "desired_state_unreachable_alarm",
        severity: "warning",
        sn,
        message: `Desired switch=${desired} for ${sn} unreachable for ${unreachableForSec}s`,
        fields: { desired, unreachableForSec }
      });
    },
    onCommandConfirmationTimeout: ({ sn, desired, cycles }) => {
      alerter.notify({
        type: "command_confirmation_timeout",
        severity: "warning",
        sn,
        message: `Device ${sn} ONLINE but did not confirm switch=${desired} after ${cycles} cycles`,
        fields: { desired, cycles }
      });
    }
  })
    .catch((error: unknown) => {
      console.error("[mqtt-worker] reconcile_loop_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => {
      reconcileLoopActive = false;
      lastReconcileLoopAt = Date.now();
    });
}, appConfig.reconcileIntervalMs);

// Headless worker liveness/readiness/metrics for orchestrator probes and scraping.
const healthServer = createWorkerHealthServer({
  port: appConfig.workerHealthPort,
  pool: dbPool,
  readyMaxLoopAgeSec: appConfig.workerReadyMaxLoopAgeSec,
  log,
  getState: () => ({
    mqttConnected,
    inboundQueueDepth: inboundQueue.length,
    inboundActive,
    lastPublishLoopAt,
    lastReconcileLoopAt,
    alertStats: alerter.stats()
  })
});

// Last-resort safety net: a resilient "never give up" worker must not die from a transient
// rejection/fault (DB blip, broker hiccup). Log loudly and keep running; the periodic loops retry.
process.on("unhandledRejection", (reason) => {
  console.error("[mqtt-worker] unhandledRejection (kept alive)", {
    message: reason instanceof Error ? reason.message : String(reason)
  });
  alerter.notify({
    type: "worker_unhandled_rejection",
    severity: "critical",
    message: "Worker hit an unhandled promise rejection (kept alive)",
    fields: { reason: reason instanceof Error ? reason.message : String(reason) }
  });
});
process.on("uncaughtException", (error) => {
  console.error("[mqtt-worker] uncaughtException (kept alive)", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  alerter.notify({
    type: "worker_uncaught_exception",
    severity: "critical",
    message: "Worker hit an uncaught exception (kept alive)",
    fields: { error: error instanceof Error ? error.message : String(error) }
  });
});

const shutdown = async (): Promise<void> => {
  healthServer.close();
  await dbPool.end();
  client.end(true);
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
