import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { appConfig, generateCommandMsgid } from "@communication/core";
import {
  addCommandEvent,
  createCommandPolicyProfile,
  createDiagnosticRun,
  createCommand,
  createDbPool,
  getDeviceBySn,
  getDiagnosticRunById,
  getCommandWithEvents,
  getEffectivePolicyForDevice,
  getDeviceSummaryBySn,
  getLatestStateBySn,
  listDevices,
  listRecentRawMqttMessages,
  listCommandPolicyProfiles,
  listCommandsBySn,
  setDeviceCommandPolicyOverride,
  updateCommandPolicyProfile,
  getInFlightCommandForDevice,
  countCommandsInWindow,
  countSwitchCommandsInWindow,
  describeEffectiveCommandOrchestration,
  POLICY_RESOLUTION_ORDER,
  buildDeviceOperationalShadow,
  aggregateCommandOrchestrationMetrics,
  buildMaintenanceUiSections,
  getRecentCommandsSummary,
  upsertDesiredSwitch,
  cancelDesiredState,
  getDesiredState,
  getPresence,
  decodeSwitchFromAdfState1,
  getDeviceCadence,
  deriveAdaptiveTiming,
  isManagedRegistryStatus,
  listPropertyTypes,
  createPropertyType,
  listCustomers,
  createCustomer,
  registerDevice,
  bulkRegisterDevices,
  getDeviceRegistry,
  listDevicesRegistry,
  approveQuarantinedDevice,
  setDeviceLifecycle
} from "@communication/db";
import type { DeviceMetadataInput, ListDevicesRegistryFilter } from "@communication/db";
import type { CommandType, UpdatePolicyProfileInput } from "@communication/db";

/** Matches node-pg `DatabaseError` without importing `pg` in this package. */
type PgLikeError = Error & { code?: string; constraint?: string; table?: string; detail?: string };

const isPgLikeError = (e: unknown): e is PgLikeError =>
  e instanceof Error && typeof (e as PgLikeError).code === "string";

/** Accept camelCase or snake_case; empty strings treated as unset. */
const readOptionalTrimmed = (
  body: Record<string, unknown>,
  camel: string,
  snake: string
): string | undefined => {
  const a = body[camel];
  const b = body[snake];
  if (typeof a === "string") {
    const t = a.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof b === "string") {
    const t = b.trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
};

/** `policyProfileId` or `policy_profile_id` — number or numeric string (bigint id). */
const readPolicyProfileIdFromBody = (body: Record<string, unknown>): string | null => {
  const raw = body.policyProfileId ?? body.policy_profile_id;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (!Number.isInteger(raw)) {
      return null;
    }
    return String(raw);
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (/^\d+$/.test(t)) {
      return t;
    }
  }
  return null;
};

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "8mb" }));
// Static manual-test control UI (served same-origin so the page can call the API without CORS).
// Served before auth so the page itself loads and can prompt for the token.
app.use(express.static(path.join(process.cwd(), "public")));

// Bearer-token auth. Probes/scrapers (/health,/ready,/metrics) stay open. When no token is
// configured, auth is disabled (dev convenience) with a loud boot warning.
const apiAuthToken = appConfig.apiAuthToken;
const OPEN_PATHS = new Set(["/health", "/ready", "/metrics"]);
const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
};
if (!apiAuthToken) {
  console.warn("[api] WARNING: API_AUTH_TOKEN not set — API authentication is DISABLED (open API)");
}
app.use((req, res, next) => {
  if (!apiAuthToken || OPEN_PATHS.has(req.path)) {
    next();
    return;
  }
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = match?.[1];
  if (presented === undefined || !safeEqual(presented, apiAuthToken)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

const port = appConfig.apiPort ?? 3000;
const dbPool = createDbPool({
  host: appConfig.postgresHost ?? "127.0.0.1",
  port: appConfig.postgresPort ?? 5433,
  database: appConfig.postgresDb ?? "communication",
  user: appConfig.postgresUser ?? "postgres",
  password: appConfig.postgresPassword ?? "postgres"
});

const apiStartedAt = Date.now();

// Cached DB health so a burst of probes/scrapes cannot stampede the pool.
let dbUp = false;
let lastDbPingAt = 0;
const DB_PING_TTL_MS = 3000;
const pingDb = async (): Promise<boolean> => {
  const now = Date.now();
  if (now - lastDbPingAt < DB_PING_TTL_MS) {
    return dbUp;
  }
  lastDbPingAt = now;
  try {
    await dbPool.query("SELECT 1");
    dbUp = true;
  } catch {
    dbUp = false;
  }
  return dbUp;
};

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "api"
  });
});

app.get("/ready", async (_req, res) => {
  const config = {
    apiPort: appConfig.apiPort !== null,
    postgresHost: appConfig.postgresHost !== null,
    postgresPort: appConfig.postgresPort !== null,
    mqttHost: appConfig.mqttHost !== null,
    mqttPort: appConfig.mqttPort !== null
  };
  const configOk = Object.values(config).every(Boolean);
  const dbHealthy = await pingDb();
  const ready = configOk && dbHealthy;

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    service: "api",
    nodeEnv: appConfig.nodeEnv,
    checks: { config: configOk, dbUp: dbHealthy },
    config
  });
});

app.get("/metrics", async (_req, res) => {
  const dbHealthy = await pingDb();
  const mem = process.memoryUsage();
  const uptimeSec = Math.round((Date.now() - apiStartedAt) / 1000);
  const lines = [
    "# HELP api_up API process is running.",
    "# TYPE api_up gauge",
    "api_up 1",
    "# HELP api_uptime_seconds Seconds since API start.",
    "# TYPE api_uptime_seconds gauge",
    `api_uptime_seconds ${uptimeSec}`,
    "# HELP api_db_up 1 if the last DB ping succeeded.",
    "# TYPE api_db_up gauge",
    `api_db_up ${dbHealthy ? 1 : 0}`,
    "# HELP api_process_resident_memory_bytes Resident set size in bytes.",
    "# TYPE api_process_resident_memory_bytes gauge",
    `api_process_resident_memory_bytes ${mem.rss}`
  ];
  res.status(200).set("content-type", "text/plain; version=0.0.4").send(lines.join("\n") + "\n");
});

app.get("/messages/raw", async (_req, res) => {
  try {
    const rows = await listRecentRawMqttMessages(dbPool, 20);
    res.status(200).json({
      count: rows.length,
      items: rows
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown db read error";
    console.error("[api] failed to fetch raw messages", { message });
    res.status(500).json({
      error: "failed_to_fetch_raw_messages"
    });
  }
});

const createDeviceCommand = async (
  sn: string,
  commandType: CommandType,
  idempotencyKey?: string
) => {
  const device = await getDeviceBySn(dbPool, sn);
  if (!device || !device.product_key) {
    return null;
  }
  if (!isManagedRegistryStatus(device.registry_status)) {
    throw new Error("device_not_registered");
  }

  if (idempotencyKey) {
    const existing = await listCommandsBySn(dbPool, sn, 50);
    const byKey = existing.find((row) => {
      const payload = row.request_payload as Record<string, unknown> | null;
      return payload && payload.idempotencyKey === idempotencyKey && row.command_type === commandType;
    });
    if (byKey) {
      return byKey;
    }
  }

  const policyView = await getEffectivePolicyForDevice(dbPool, {
    sn,
    productKey: device.product_key,
    commandType
  });
  const prof = policyView.profile;

  if (commandType === "refresh") {
    const n = await countCommandsInWindow(dbPool, sn, "refresh", 1);
    const cap = prof.refresh_budget_per_hour ?? 12;
    if (n >= cap) {
      throw new Error("command_refresh_budget_exceeded");
    }
  }
  if (commandType === "force_switch_0" || commandType === "force_switch_1") {
    const n = await countSwitchCommandsInWindow(dbPool, sn, 1);
    const cap = prof.switch_budget_per_hour ?? 48;
    if (n >= cap) {
      throw new Error("command_switch_budget_exceeded");
    }
  }

  const inFlight = await getInFlightCommandForDevice(dbPool, sn);
  if (inFlight) {
    const err = new Error("device_command_pipeline_busy") as Error & {
      blockingCommandId: string;
      blockingStatus: string;
      deviceBusyMode: string;
    };
    err.blockingCommandId = inFlight.id;
    err.blockingStatus = inFlight.status;
    err.deviceBusyMode = prof.device_busy_mode ?? "reject";
    throw err;
  }

  const msgid = generateCommandMsgid();
  const requestPayload: Record<string, unknown> = {
    commandType,
    idempotencyKey: idempotencyKey ?? null
  };
  if (commandType === "force_switch_0") {
    requestPayload.switchTarget = 0;
  }
  if (commandType === "force_switch_1") {
    requestPayload.switchTarget = 1;
  }

  const command = await createCommand(dbPool, {
    sn,
    productKey: device.product_key,
    commandType,
    method: "operate",
    msgid,
    requestPayload,
    expiresAt: new Date(Date.now() + prof.command_ttl_sec * 1000),
    policySnapshot: prof
  });

  await addCommandEvent(dbPool, command.id, "created", {
    status: "scheduled",
    commandType
  });

  return command;
};

/**
 * Durable switch intent: writes desired-state and lets the worker reconciler drive the device
 * (retry-until-confirmed, presence-aware, supersede-safe). Replaces direct command creation for
 * force-switch so the "hold open/close until the device confirms" guarantee is automatic.
 */
const setDesiredSwitchForDevice = async (
  sn: string,
  value: 0 | 1,
  setBy?: string | null
) => {
  const device = await getDeviceBySn(dbPool, sn);
  if (!device || !device.product_key) {
    return null;
  }
  if (!isManagedRegistryStatus(device.registry_status)) {
    throw new Error("device_not_registered");
  }
  const result = await upsertDesiredSwitch(dbPool, {
    sn,
    productKey: device.product_key,
    value,
    setBy: setBy ?? null
  });
  return result;
};

const deviceBusyResponseBody = (error: unknown): Record<string, unknown> => {
  const e = error as Error & {
    blockingCommandId?: string;
    blockingStatus?: string;
    deviceBusyMode?: string;
  };
  const mode = e.deviceBusyMode ?? "reject";
  return {
    error: "command_blocked_device_busy",
    blockingCommandId: e.blockingCommandId ?? null,
    blockingStatus: e.blockingStatus ?? null,
    deviceBusyMode: mode,
    outboxExtension:
      mode === "queue_slot"
        ? {
            pattern: "durable_outbox",
            note: "Reserved: single-slot intent then outbound_messages row + idempotent consumer"
          }
        : null
  };
};

app.post("/devices/:sn/commands/refresh", async (req, res) => {
  const sn = req.params.sn;
  try {
    const command = await createDeviceCommand(
      sn,
      "refresh",
      req.header("x-idempotency-key") ?? undefined
    );
    if (!command) {
      res.status(404).json({ error: "device_not_found_or_missing_product_key" });
      return;
    }
    res.status(201).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown command create error";
    if (message === "device_command_pipeline_busy") {
      const e = error as Error & { blockingCommandId?: string; blockingStatus?: string };
      console.log("[api] command_blocked_device_busy", {
        sn,
        blockingCommandId: e.blockingCommandId,
        blockingStatus: e.blockingStatus
      });
      console.log("[api] orchestration_metric_increment", {
        metric: "device_busy_reject_count",
        sn
      });
      res.status(409).json(deviceBusyResponseBody(error));
      return;
    }
    if (message === "command_refresh_budget_exceeded") {
      res.status(429).json({ error: "command_refresh_budget_exceeded" });
      return;
    }
    if (message === "command_switch_budget_exceeded") {
      res.status(429).json({ error: "command_switch_budget_exceeded" });
      return;
    }
    if (message === "device_not_registered") {
      res.status(403).json({ error: "device_not_registered", detail: "Device is quarantined; register it before sending commands." });
      return;
    }
    console.error("[api] failed to create refresh command", { sn, message });
    res.status(500).json({ error: "failed_to_create_command" });
  }
});

/** Backward-compatible: same path the UI already calls, now backed by durable desired-state. */
const handleForceSwitch = async (req: express.Request, res: express.Response, value: 0 | 1) => {
  const sn = req.params.sn;
  if (!sn) {
    res.status(400).json({ error: "missing_sn" });
    return;
  }
  try {
    const setBy = readOptionalTrimmed(
      (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>,
      "setBy",
      "set_by"
    ) ?? null;
    const result = await setDesiredSwitchForDevice(sn, value, setBy);
    if (!result) {
      res.status(404).json({ error: "device_not_found_or_missing_product_key" });
      return;
    }
    res.status(202).json({
      mode: "desired_state",
      switchTarget: value,
      superseded: result.superseded,
      cancelledCommandIds: result.cancelledCommandIds,
      desiredState: result.row,
      note: "Intent recorded; reconciler will drive and hold the device until confirmed or cancelled."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown desired switch error";
    if (message === "device_not_registered") {
      res.status(403).json({ error: "device_not_registered", detail: "Device is quarantined; register it before control." });
      return;
    }
    console.error("[api] failed to set desired switch", { sn, value, message });
    res.status(500).json({ error: "failed_to_set_desired_switch" });
  }
};

app.post("/devices/:sn/commands/force-switch-0", (req, res) => {
  void handleForceSwitch(req, res, 0);
});

app.post("/devices/:sn/commands/force-switch-1", (req, res) => {
  void handleForceSwitch(req, res, 1);
});

app.put("/devices/:sn/desired/switch", async (req, res) => {
  const sn = req.params.sn;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const rawValue = body.value ?? body.switch;
  const value: 0 | 1 | null = rawValue === 0 || rawValue === "0" ? 0 : rawValue === 1 || rawValue === "1" ? 1 : null;
  if (value === null) {
    res.status(400).json({ error: "invalid_switch_value", detail: "value must be 0 or 1" });
    return;
  }
  try {
    const setBy = readOptionalTrimmed(body, "setBy", "set_by") ?? null;
    const result = await setDesiredSwitchForDevice(sn, value, setBy);
    if (!result) {
      res.status(404).json({ error: "device_not_found_or_missing_product_key" });
      return;
    }
    res.status(202).json({
      switchTarget: value,
      superseded: result.superseded,
      cancelledCommandIds: result.cancelledCommandIds,
      desiredState: result.row
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown desired switch error";
    if (message === "device_not_registered") {
      res.status(403).json({ error: "device_not_registered", detail: "Device is quarantined; register it before control." });
      return;
    }
    console.error("[api] failed to put desired switch", { sn, value, message });
    res.status(500).json({ error: "failed_to_set_desired_switch" });
  }
});

app.delete("/devices/:sn/desired/switch", async (req, res) => {
  const sn = req.params.sn;
  try {
    const row = await cancelDesiredState(dbPool, sn);
    if (!row) {
      res.status(404).json({ error: "no_desired_state" });
      return;
    }
    res.status(200).json({ cancelled: true, desiredState: row });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown cancel desired error";
    console.error("[api] failed to cancel desired switch", { sn, message });
    res.status(500).json({ error: "failed_to_cancel_desired_switch" });
  }
});

app.get("/devices/:sn/desired", async (req, res) => {
  const sn = req.params.sn;
  try {
    const desired = await getDesiredState(dbPool, sn);
    const presence = await getPresence(dbPool, sn);
    const inFlight = await getInFlightCommandForDevice(dbPool, sn);
    res.status(200).json({ sn, desiredState: desired, presence, inFlightCommand: inFlight });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown desired fetch error";
    console.error("[api] failed to fetch desired state", { sn, message });
    res.status(500).json({ error: "failed_to_fetch_desired_state" });
  }
});

app.get("/devices/:sn/commands", async (req, res) => {
  const sn = req.params.sn;
  try {
    const items = await listCommandsBySn(dbPool, sn, 200);
    res.status(200).json({ count: items.length, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown command list error";
    console.error("[api] failed to list commands by sn", { sn, message });
    res.status(500).json({ error: "failed_to_list_commands" });
  }
});

app.get("/command-policy-profiles", async (_req, res) => {
  try {
    const items = await listCommandPolicyProfiles(dbPool);
    res.status(200).json({ count: items.length, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy list error";
    console.error("[api] failed to list policy profiles", { message });
    res.status(500).json({ error: "failed_to_list_policy_profiles" });
  }
});

app.post("/command-policy-profiles", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const created = await createCommandPolicyProfile(dbPool, {
      code: String(body.code),
      name: String(body.name),
      isDefault: Boolean(body.isDefault ?? false),
      enabled: Boolean(body.enabled ?? true),
      ackTimeoutSec: Number(body.ackTimeoutSec),
      verifyTimeoutSec: Number(body.verifyTimeoutSec),
      commandTtlSec: Number(body.commandTtlSec),
      quickRetrySeconds: Array.isArray(body.quickRetrySeconds)
        ? body.quickRetrySeconds.map((v) => Number(v))
        : [],
      slowRetrySeconds: Array.isArray(body.slowRetrySeconds)
        ? body.slowRetrySeconds.map((v) => Number(v))
        : [],
      verifyRefreshDelaysSec: Array.isArray(body.verifyRefreshDelaysSec)
        ? body.verifyRefreshDelaysSec.map((v) => Number(v))
        : [],
      refreshBudgetPerHour: Number(body.refreshBudgetPerHour),
      diagnosticsIntervalMs: Number(body.diagnosticsIntervalMs),
      diagnosticsDurationSec: Number(body.diagnosticsDurationSec),
      maxAttempts: Number(body.maxAttempts),
      ...(typeof body.ackRetryMinDelaySec === "number" ? { ackRetryMinDelaySec: body.ackRetryMinDelaySec } : {}),
      ...(typeof body.telemetryCycleSec === "number" ? { telemetryCycleSec: body.telemetryCycleSec } : {}),
      ...(typeof body.lateConfirmationWindowSec === "number"
        ? { lateConfirmationWindowSec: body.lateConfirmationWindowSec }
        : {}),
      ...(typeof body.switchBudgetPerHour === "number" ? { switchBudgetPerHour: body.switchBudgetPerHour } : {}),
      ...(typeof body.singleFlightEnabled === "boolean" ? { singleFlightEnabled: body.singleFlightEnabled } : {}),
      ...(typeof body.deviceBusyMode === "string" ? { deviceBusyMode: body.deviceBusyMode } : {}),
      ...(typeof body.retryBackoffMode === "string" ? { retryBackoffMode: body.retryBackoffMode } : {}),
      ...(typeof body.retryJitterPct === "number" ? { retryJitterPct: body.retryJitterPct } : {}),
      ...(typeof body.autoRefreshAfterSwitchEnabled === "boolean"
        ? { autoRefreshAfterSwitchEnabled: body.autoRefreshAfterSwitchEnabled }
        : {}),
      ...(typeof body.autoRefreshDelaySec === "number" ? { autoRefreshDelaySec: body.autoRefreshDelaySec } : {}),
      ...(typeof body.parentFinalizeFromChildRefresh === "boolean"
        ? { parentFinalizeFromChildRefresh: body.parentFinalizeFromChildRefresh }
        : {}),
      ...(typeof body.parentLateSuccessEnabled === "boolean"
        ? { parentLateSuccessEnabled: body.parentLateSuccessEnabled }
        : {}),
      ...(typeof body.retryIntervalSec === "number" ? { retryIntervalSec: body.retryIntervalSec } : {}),
      ...(typeof body.deliveryWindowSec === "number" ? { deliveryWindowSec: body.deliveryWindowSec } : {}),
      ...(typeof body.raiseCommunicationFaultEnabled === "boolean"
        ? { raiseCommunicationFaultEnabled: body.raiseCommunicationFaultEnabled }
        : {}),
      ...(typeof body.faultIfOnlineButNoAckAfterSec === "number"
        ? { faultIfOnlineButNoAckAfterSec: body.faultIfOnlineButNoAckAfterSec }
        : {}),
      ...(body.faultIfOnlineButNoAckAfterSec === null ? { faultIfOnlineButNoAckAfterSec: null } : {}),
      ...(typeof body.faultIfOnlineButNoVerifyAfterSec === "number"
        ? { faultIfOnlineButNoVerifyAfterSec: body.faultIfOnlineButNoVerifyAfterSec }
        : {}),
      ...(body.faultIfOnlineButNoVerifyAfterSec === null ? { faultIfOnlineButNoVerifyAfterSec: null } : {})
    });
    res.status(201).json(created);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy create error";
    console.error("[api] failed to create policy profile", { message });
    res.status(500).json({ error: "failed_to_create_policy_profile" });
  }
});

app.patch("/command-policy-profiles/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body as Record<string, unknown>;
    const patch: UpdatePolicyProfileInput = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.isDefault === "boolean") patch.isDefault = body.isDefault;
    if (typeof body.ackTimeoutSec === "number") patch.ackTimeoutSec = body.ackTimeoutSec;
    if (typeof body.verifyTimeoutSec === "number") patch.verifyTimeoutSec = body.verifyTimeoutSec;
    if (typeof body.commandTtlSec === "number") patch.commandTtlSec = body.commandTtlSec;
    if (Array.isArray(body.quickRetrySeconds)) {
      patch.quickRetrySeconds = body.quickRetrySeconds.map((v) => Number(v));
    }
    if (Array.isArray(body.slowRetrySeconds)) {
      patch.slowRetrySeconds = body.slowRetrySeconds.map((v) => Number(v));
    }
    if (Array.isArray(body.verifyRefreshDelaysSec)) {
      patch.verifyRefreshDelaysSec = body.verifyRefreshDelaysSec.map((v) => Number(v));
    }
    if (typeof body.refreshBudgetPerHour === "number") {
      patch.refreshBudgetPerHour = body.refreshBudgetPerHour;
    }
    if (typeof body.diagnosticsIntervalMs === "number") {
      patch.diagnosticsIntervalMs = body.diagnosticsIntervalMs;
    }
    if (typeof body.diagnosticsDurationSec === "number") {
      patch.diagnosticsDurationSec = body.diagnosticsDurationSec;
    }
    if (typeof body.maxAttempts === "number") {
      patch.maxAttempts = body.maxAttempts;
    }
    if (typeof body.ackRetryMinDelaySec === "number") {
      patch.ackRetryMinDelaySec = body.ackRetryMinDelaySec;
    }
    if (typeof body.telemetryCycleSec === "number") {
      patch.telemetryCycleSec = body.telemetryCycleSec;
    }
    if (typeof body.lateConfirmationWindowSec === "number") {
      patch.lateConfirmationWindowSec = body.lateConfirmationWindowSec;
    }
    if (typeof body.switchBudgetPerHour === "number") {
      patch.switchBudgetPerHour = body.switchBudgetPerHour;
    }
    if (typeof body.singleFlightEnabled === "boolean") {
      patch.singleFlightEnabled = body.singleFlightEnabled;
    }
    if (typeof body.deviceBusyMode === "string") {
      patch.deviceBusyMode = body.deviceBusyMode;
    }
    if (typeof body.retryBackoffMode === "string") {
      patch.retryBackoffMode = body.retryBackoffMode;
    }
    if (typeof body.retryJitterPct === "number") {
      patch.retryJitterPct = body.retryJitterPct;
    }
    if (typeof body.autoRefreshAfterSwitchEnabled === "boolean") {
      patch.autoRefreshAfterSwitchEnabled = body.autoRefreshAfterSwitchEnabled;
    }
    if (typeof body.autoRefreshDelaySec === "number") {
      patch.autoRefreshDelaySec = body.autoRefreshDelaySec;
    }
    if (typeof body.parentFinalizeFromChildRefresh === "boolean") {
      patch.parentFinalizeFromChildRefresh = body.parentFinalizeFromChildRefresh;
    }
    if (typeof body.parentLateSuccessEnabled === "boolean") {
      patch.parentLateSuccessEnabled = body.parentLateSuccessEnabled;
    }
    if (typeof body.retryIntervalSec === "number") {
      patch.retryIntervalSec = body.retryIntervalSec;
    }
    if (typeof body.deliveryWindowSec === "number") {
      patch.deliveryWindowSec = body.deliveryWindowSec;
    }
    if (typeof body.raiseCommunicationFaultEnabled === "boolean") {
      patch.raiseCommunicationFaultEnabled = body.raiseCommunicationFaultEnabled;
    }
    if (typeof body.faultIfOnlineButNoAckAfterSec === "number") {
      patch.faultIfOnlineButNoAckAfterSec = body.faultIfOnlineButNoAckAfterSec;
    } else if (body.faultIfOnlineButNoAckAfterSec === null) {
      patch.faultIfOnlineButNoAckAfterSec = null;
    }
    if (typeof body.faultIfOnlineButNoVerifyAfterSec === "number") {
      patch.faultIfOnlineButNoVerifyAfterSec = body.faultIfOnlineButNoVerifyAfterSec;
    } else if (body.faultIfOnlineButNoVerifyAfterSec === null) {
      patch.faultIfOnlineButNoVerifyAfterSec = null;
    }

    const row = await updateCommandPolicyProfile(dbPool, id, patch);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy patch error";
    console.error("[api] failed to patch policy profile", { message });
    res.status(500).json({ error: "failed_to_patch_policy_profile" });
  }
});

app.get("/devices/:sn/command-policy", async (req, res) => {
  const sn = req.params.sn;
  const commandTypeParam = req.query.commandType;
  const commandType =
    typeof commandTypeParam === "string" && commandTypeParam.length > 0
      ? (commandTypeParam as CommandType)
      : null;
  try {
    const row = await getEffectivePolicyForDevice(dbPool, { sn, commandType });
    res.status(200).json({
      ...row,
      resolvedOrchestration: describeEffectiveCommandOrchestration(row.profile)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy fetch error";
    console.error("[api] failed to fetch device policy", { sn, message });
    res.status(500).json({ error: "failed_to_fetch_device_policy" });
  }
});

app.get("/devices/:sn/command-diagnostics", async (req, res) => {
  const sn = req.params.sn;
  try {
    const device = await getDeviceBySn(dbPool, sn);
    if (!device || !device.product_key) {
      res.status(404).json({ error: "device_not_found_or_missing_product_key" });
      return;
    }
    const policyView = await getEffectivePolicyForDevice(dbPool, {
      sn,
      productKey: device.product_key,
      commandType: null
    });
    const resolved = describeEffectiveCommandOrchestration(policyView.profile);
    const deviceShadow = await buildDeviceOperationalShadow(dbPool, sn);
    const metrics = await aggregateCommandOrchestrationMetrics(dbPool, sn, 7);
    const recentCommandsSummary = await getRecentCommandsSummary(dbPool, sn, 30);
    const ui = buildMaintenanceUiSections(policyView.profile, resolved);
    res.status(200).json({
      sn,
      policyResolutionOrder: POLICY_RESOLUTION_ORDER,
      effectivePolicy: {
        source: policyView.source,
        commandType: policyView.command_type,
        override: policyView.override,
        profile: policyView.profile,
        resolvedOrchestration: resolved
      },
      deviceShadow,
      metrics,
      recentCommandsSummary,
      ui,
      outboxDesignNote:
        "Commands table + worker claim loop is step 0. Scale path: outbound outbox table (delivery_state, idempotent publish), replay consumer, DLQ; telemetry already durable in raw/log tables."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown command diagnostics error";
    console.error("[api] failed to fetch command diagnostics", { sn, message });
    res.status(500).json({ error: "failed_to_fetch_command_diagnostics" });
  }
});

app.put("/devices/:sn/command-policy", async (req, res) => {
  const sn = req.params.sn;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  const policyProfileId = readPolicyProfileIdFromBody(body);
  if (policyProfileId === null) {
    const raw = body.policyProfileId ?? body.policy_profile_id;
    const reason =
      raw === undefined || raw === null
        ? "missing_policy_profile_id"
        : "invalid_policy_profile_id_format";
    console.error("[api] device command-policy PUT rejected", { sn, reason, raw });
    res.status(400).json({
      error: "invalid_device_command_policy_body",
      detail: {
        code: reason,
        message:
          reason === "missing_policy_profile_id"
            ? "Provide policyProfileId or policy_profile_id (integer id of an existing command_policy_profiles row)."
            : "policyProfileId must be an integer (or numeric string), not a profile code name."
      }
    });
    return;
  }

  const productKey = readOptionalTrimmed(body, "productKey", "product_key") ?? null;
  const commandTypeRaw = readOptionalTrimmed(body, "commandType", "command_type");
  const commandType = commandTypeRaw ? (commandTypeRaw as CommandType) : null;

  try {
    const row = await setDeviceCommandPolicyOverride(dbPool, {
      sn,
      productKey,
      commandType,
      policyProfileId
    });
    res.status(200).json(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isPgLikeError(error)) {
      const pg = error;
      console.error("[api] failed to set device policy override (postgres)", {
        sn,
        policyProfileId,
        pgCode: pg.code,
        constraint: pg.constraint,
        table: pg.table,
        detail: pg.detail,
        message: pg.message
      });
      if (pg.code === "23503") {
        res.status(400).json({
          error: "device_command_policy_foreign_key_violation",
          detail: {
            code: "policy_profile_not_found_or_invalid_id",
            pgCode: pg.code,
            constraint: pg.constraint ?? null,
            message:
              "policy_profile_id does not reference an existing command_policy_profiles row (or id is invalid)."
          }
        });
        return;
      }
      if (pg.code === "22P02") {
        res.status(400).json({
          error: "device_command_policy_invalid_input",
          detail: {
            code: "invalid_bigint_for_policy_profile_id",
            pgCode: pg.code,
            message: pg.message
          }
        });
        return;
      }
    } else {
      console.error("[api] failed to set device policy override", { sn, policyProfileId, message });
    }
    res.status(500).json({
      error: "failed_to_set_device_policy_override",
      detail: {
        code: "unexpected_error",
        message
      }
    });
  }
});

app.post("/devices/:sn/diagnostics", async (req, res) => {
  const sn = req.params.sn;
  try {
    const device = await getDeviceBySn(dbPool, sn);
    if (!device || !device.product_key) {
      res.status(404).json({ error: "device_not_found_or_missing_product_key" });
      return;
    }
    const policy = await getEffectivePolicyForDevice(dbPool, { sn, productKey: device.product_key });
    const intervalMs =
      typeof req.body?.intervalMs === "number"
        ? req.body.intervalMs
        : policy.profile.diagnostics_interval_ms;
    const durationSec =
      typeof req.body?.durationSec === "number"
        ? req.body.durationSec
        : policy.profile.diagnostics_duration_sec;
    const plannedCount = Math.max(1, Math.floor((durationSec * 1000) / Math.max(1, intervalMs)));

    const run = await createDiagnosticRun(dbPool, {
      sn,
      productKey: device.product_key,
      intervalMs,
      durationSec,
      plannedCount
    });
    res.status(201).json(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown diagnostics error";
    if (message === "diagnostic_already_active_for_device") {
      res.status(409).json({ error: "diagnostic_already_active_for_device" });
      return;
    }
    console.error("[api] failed to create diagnostics run", { sn, message });
    res.status(500).json({ error: "failed_to_create_diagnostics_run" });
  }
});

app.get("/diagnostics/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const row = await getDiagnosticRunById(dbPool, id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown diagnostics read error";
    console.error("[api] failed to fetch diagnostic run", { id, message });
    res.status(500).json({ error: "failed_to_fetch_diagnostic_run" });
  }
});

app.get("/commands/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const detail = await getCommandWithEvents(dbPool, id);
    if (!detail) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown command read error";
    console.error("[api] failed to fetch command detail", { id, message });
    res.status(500).json({ error: "failed_to_fetch_command" });
  }
});

app.get("/devices", async (_req, res) => {
  try {
    const items = await listDevices(dbPool);
    res.status(200).json({
      count: items.length,
      items
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown db read error";
    console.error("[api] failed to list devices", { message });
    res.status(500).json({ error: "failed_to_list_devices" });
  }
});

// ---- Device registry (customers, property types, registration, whitelist) ----

app.get("/property-types", async (_req, res) => {
  try {
    res.status(200).json({ items: await listPropertyTypes(dbPool) });
  } catch (error) {
    console.error("[api] failed to list property types", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_list_property_types" });
  }
});

app.post("/property-types", async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!code || !label) {
    res.status(400).json({ error: "code_and_label_required" });
    return;
  }
  try {
    const row = await createPropertyType(
      dbPool,
      typeof body.sortOrder === "number" ? { code, label, sortOrder: body.sortOrder } : { code, label }
    );
    res.status(201).json(row);
  } catch (error) {
    console.error("[api] failed to create property type", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_create_property_type" });
  }
});

app.get("/customers", async (_req, res) => {
  try {
    res.status(200).json({ items: await listCustomers(dbPool) });
  } catch (error) {
    console.error("[api] failed to list customers", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_list_customers" });
  }
});

app.post("/customers", async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }
  try {
    const row = await createCustomer(dbPool, {
      name,
      phone: typeof body.phone === "string" ? body.phone : null,
      email: typeof body.email === "string" ? body.email : null,
      notes: typeof body.notes === "string" ? body.notes : null
    });
    res.status(201).json(row);
  } catch (error) {
    console.error("[api] failed to create customer", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_create_customer" });
  }
});

// Detailed registry list with optional ?status= and ?q= filters.
app.get("/registry/devices", async (req, res) => {
  try {
    const filter: ListDevicesRegistryFilter = {
      status: typeof req.query.status === "string" ? req.query.status : null,
      search: typeof req.query.q === "string" ? req.query.q : null
    };
    if (typeof req.query.limit === "string") filter.limit = Number(req.query.limit);
    if (typeof req.query.offset === "string") filter.offset = Number(req.query.offset);
    const items = await listDevicesRegistry(dbPool, filter);
    res.status(200).json({ count: items.length, items });
  } catch (error) {
    console.error("[api] failed to list registry devices", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_list_registry_devices" });
  }
});

app.get("/registry/devices/:sn", async (req, res) => {
  try {
    const row = await getDeviceRegistry(dbPool, req.params.sn);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(row);
  } catch (error) {
    console.error("[api] failed to get registry device", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_get_registry_device" });
  }
});

// Resolve a raw metadata object (from JSON or CSV) into DeviceMetadataInput, mapping
// property_type_code -> id when needed.
const toMetadataInput = (
  raw: Record<string, unknown>,
  propertyTypeByCode: Map<string, number>
): DeviceMetadataInput | { error: string } => {
  const sn = typeof raw.sn === "string" ? raw.sn.trim() : "";
  if (!sn) {
    return { error: "missing_sn" };
  }
  const str = (k: string): string | null | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return undefined;
    return String(v).trim();
  };
  const num = (k: string): number | null | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  let propertyTypeId = num("propertyTypeId") ?? num("property_type_id");
  const ptCode = str("propertyTypeCode") ?? str("property_type_code");
  if (propertyTypeId === undefined && ptCode) {
    propertyTypeId = propertyTypeByCode.get(ptCode.toLowerCase());
  }
  return {
    sn,
    productKey: str("productKey") ?? str("product_key") ?? null,
    label: str("label") ?? null,
    subscriberNo: str("subscriberNo") ?? str("subscriber_no") ?? null,
    customerId: str("customerId") ?? str("customer_id") ?? null,
    propertyTypeId: propertyTypeId ?? null,
    addressLine: str("addressLine") ?? str("address_line") ?? null,
    district: str("district") ?? null,
    city: str("city") ?? null,
    lat: num("lat") ?? null,
    lng: num("lng") ?? null,
    tariff: str("tariff") ?? null,
    region: str("region") ?? null,
    dealer: str("dealer") ?? null,
    installDate: str("installDate") ?? str("install_date") ?? null,
    notes: str("notes") ?? null
  };
};

// Single device registration / metadata update (promotes quarantined/auto -> registered).
app.post("/registry/devices", async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  try {
    const ptMap = new Map((await listPropertyTypes(dbPool)).map((p) => [p.code.toLowerCase(), p.id]));
    const parsed = toMetadataInput(body, ptMap);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    await registerDevice(dbPool, parsed);
    res.status(201).json(await getDeviceRegistry(dbPool, parsed.sn));
  } catch (error) {
    console.error("[api] failed to register device", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_register_device" });
  }
});

app.patch("/registry/devices/:sn", async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  try {
    const ptMap = new Map((await listPropertyTypes(dbPool)).map((p) => [p.code.toLowerCase(), p.id]));
    const parsed = toMetadataInput({ ...body, sn: req.params.sn }, ptMap);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    await registerDevice(dbPool, parsed);
    res.status(200).json(await getDeviceRegistry(dbPool, parsed.sn));
  } catch (error) {
    console.error("[api] failed to update device", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_update_device" });
  }
});

app.post("/registry/devices/:sn/approve", async (req, res) => {
  try {
    const ok = await approveQuarantinedDevice(dbPool, req.params.sn);
    if (!ok) {
      res.status(404).json({ error: "not_quarantined_or_not_found" });
      return;
    }
    res.status(200).json(await getDeviceRegistry(dbPool, req.params.sn));
  } catch (error) {
    console.error("[api] failed to approve device", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_approve_device" });
  }
});

app.post("/registry/devices/:sn/lifecycle", async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const lifecycle = typeof body.lifecycle === "string" ? body.lifecycle : "";
  if (!["registered", "commissioned", "active", "decommissioned"].includes(lifecycle)) {
    res.status(400).json({ error: "invalid_lifecycle" });
    return;
  }
  try {
    const ok = await setDeviceLifecycle(dbPool, req.params.sn, lifecycle as "registered" | "commissioned" | "active" | "decommissioned");
    if (!ok) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(await getDeviceRegistry(dbPool, req.params.sn));
  } catch (error) {
    console.error("[api] failed to set lifecycle", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_set_lifecycle" });
  }
});

// Minimal RFC4180-ish CSV parser (handles quoted fields, commas, CRLF).
const parseCsv = (text: string): Array<Record<string, string>> => {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim().length > 0));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0]!.map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
    return obj;
  });
};

// Bulk import. Accepts JSON { devices: [...] } or raw CSV text (text/csv).
app.post("/registry/devices/import", async (req, res) => {
  try {
    const ptMap = new Map((await listPropertyTypes(dbPool)).map((p) => [p.code.toLowerCase(), p.id]));
    let rawRows: Array<Record<string, unknown>> = [];
    if (typeof req.body === "string") {
      rawRows = parseCsv(req.body);
    } else if (req.body && typeof req.body === "object" && Array.isArray((req.body as Record<string, unknown>).devices)) {
      rawRows = (req.body as { devices: Array<Record<string, unknown>> }).devices;
    } else {
      res.status(400).json({ error: "expected_csv_text_or_devices_array" });
      return;
    }
    const inputs: DeviceMetadataInput[] = [];
    const rejected: Array<{ sn: string; error: string }> = [];
    for (const raw of rawRows) {
      const parsed = toMetadataInput(raw, ptMap);
      if ("error" in parsed) {
        rejected.push({ sn: typeof raw.sn === "string" ? raw.sn : "", error: parsed.error });
      } else {
        inputs.push(parsed);
      }
    }
    const result = await bulkRegisterDevices(dbPool, inputs);
    res.status(200).json({ ...result, total: rawRows.length, rejected: [...rejected, ...result.failed] });
  } catch (error) {
    console.error("[api] failed to import devices", { message: error instanceof Error ? error.message : error });
    res.status(500).json({ error: "failed_to_import_devices" });
  }
});

app.get("/devices/:sn/latest-state", async (req, res) => {
  const sn = req.params.sn;
  try {
    const row = await getLatestStateBySn(dbPool, sn);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown db read error";
    console.error("[api] failed to fetch latest_state", { sn, message });
    res.status(500).json({ error: "failed_to_fetch_latest_state" });
  }
});

/**
 * Numeric-ish field reader (device sends meter values as strings).
 */
const numericField = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * Extract meter fields from latest_state.last_payload (reported[sn].{...}). This device does NOT
 * emit SwitchSta; the relay position is reflected empirically in PRESTATE/AdfState1 (validated by
 * live ON/OFF field test on SN 24042809890002): OFF≈{PRESTATE:699, AdfState1:488},
 * ON≈{PRESTATE:570, AdfState1:57583}.
 */
const extractMeterFields = (lastPayload: unknown, sn: string) => {
  const root = lastPayload && typeof lastPayload === "object" ? (lastPayload as Record<string, unknown>) : null;
  const reported = root && typeof root.reported === "object" && root.reported ? (root.reported as Record<string, unknown>) : null;
  const dev = reported && typeof reported[sn] === "object" && reported[sn] ? (reported[sn] as Record<string, unknown>) : null;
  return {
    prestate: numericField(dev?.PRESTATE),
    adfState1: numericField(dev?.AdfState1),
    adfState2: numericField(dev?.AdfState2),
    oweMoney: numericField(dev?.OweMoney),
    balance: numericField(dev?.Balance),
    epi: numericField(dev?.EPI),
    rssi: numericField(dev?.rssi)
  };
};

/** Empirical decode (see extractMeterFields). AdfState1 high (>1000) => relay ON. */
const decodeSwitch = (adfState1: number | null): "on" | "off" | "unknown" => {
  const decoded = decodeSwitchFromAdfState1(adfState1);
  if (decoded === null) return "unknown";
  return decoded === 1 ? "on" : "off";
};

app.get("/devices/:sn/control-view", async (req, res) => {
  const sn = req.params.sn;
  try {
    const [latest, desired, commands, cadence, policyView] = await Promise.all([
      getLatestStateBySn(dbPool, sn),
      getDesiredState(dbPool, sn),
      listCommandsBySn(dbPool, sn, 6),
      getDeviceCadence(dbPool, sn),
      getEffectivePolicyForDevice(dbPool, { sn }, { adaptiveTiming: false })
    ]);
    const adaptiveTiming = deriveAdaptiveTiming(policyView.profile, cadence);
    const meter = extractMeterFields(latest?.last_payload, sn);
    const lastSeen = latest?.last_timestamp ?? null;
    const onlineFresh = lastSeen ? Date.now() - new Date(lastSeen).getTime() < 5 * 60 * 1000 : false;
    const recentCommands = commands.map((c) => ({
      id: c.id,
      command_type: c.command_type,
      status: c.status,
      attempt_count: c.attempt_count,
      created_at: c.created_at,
      published_at: c.published_at,
      ack_at: c.ack_at,
      verified_at: c.verified_at,
      ack_latency_ms:
        c.published_at && c.ack_at
          ? new Date(c.ack_at).getTime() - new Date(c.published_at).getTime()
          : null
    }));
    res.status(200).json({
      sn,
      lastMethod: latest?.last_method ?? null,
      lastSeen,
      onlineFresh,
      meter,
      switchDecoded: decodeSwitch(meter.adfState1),
      desired: desired
        ? {
            reconcile_status: desired.reconcile_status,
            desired_value: desired.desired_value,
            attempt_count: desired.attempt_count,
            last_command_id: desired.last_command_id,
            next_eval_at: desired.next_eval_at
          }
        : null,
      cadence: cadence
        ? {
            ewmaReconnectSec: cadence.ewma_reconnect_sec,
            lastGapSec: cadence.last_gap_sec,
            minGapSec: cadence.min_gap_sec,
            maxGapSec: cadence.max_gap_sec,
            sampleCount: cadence.sample_count,
            lastLoginAt: cadence.last_login_at
          }
        : null,
      adaptiveTiming,
      recentCommands
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown control view error";
    console.error("[api] failed to build control view", { sn, message });
    res.status(500).json({ error: "failed_to_build_control_view" });
  }
});

app.get("/devices/:sn/summary", async (req, res) => {
  const sn = req.params.sn;
  try {
    const row = await getDeviceSummaryBySn(dbPool, sn);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown db read error";
    console.error("[api] failed to fetch device summary", { sn, message });
    res.status(500).json({ error: "failed_to_fetch_device_summary" });
  }
});

app.get("/devices/:sn", async (req, res) => {
  const sn = req.params.sn;
  try {
    const row = await getDeviceBySn(dbPool, sn);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown db read error";
    console.error("[api] failed to fetch device", { sn, message });
    res.status(500).json({ error: "failed_to_fetch_device" });
  }
});

app.listen(port, () => {
  console.log(`[api] booted on port ${port}`);
});
