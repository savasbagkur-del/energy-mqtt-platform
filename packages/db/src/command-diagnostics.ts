import type { Pool } from "pg";
import type { CommandRow, CommandStatus } from "./types.js";
import { getDeviceBySn } from "./devices.js";
import { getLatestStateBySn } from "./latest-state.js";
import {
  describeEffectiveCommandOrchestration,
  getEffectivePolicyForDevice
} from "./policies.js";
import { getInFlightCommandForDevice, listCommandsBySn } from "./commands.js";

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Observed switch from latest_state.last_summary (telemetry mapping untouched; field read only). */
const readObservedSwitchFromSummary = (lastSummary: unknown): number | null => {
  const s = asObject(lastSummary);
  if (!s) {
    return null;
  }
  const reported = asObject(s.reported);
  const raw = reported?.SwitchSta ?? s.SwitchSta;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const desiredFromCommand = (row: CommandRow | null): number | null => {
  if (!row) {
    return null;
  }
  if (row.command_type === "force_switch_0") {
    return 0;
  }
  if (row.command_type === "force_switch_1") {
    return 1;
  }
  const rp = asObject(row.request_payload);
  const st = rp?.switchTarget;
  if (typeof st === "number" && Number.isFinite(st)) {
    return st;
  }
  return null;
};

export type DeviceOperationalShadow = {
  sn: string;
  desiredSwitchState: number | null;
  observedSwitchState: number | null;
  lastSeenAt: string | null;
  lastAckAt: string | null;
  lastVerifiedAt: string | null;
  activeCommandId: string | null;
  activeCommandStatus: string | null;
  deviceBusyUntil: string | null;
  telemetryCycleSecEffective: number;
  lastRefreshSuccessAt: string | null;
  lastSwitchSuccessAt: string | null;
};

export type CommandOrchestrationMetricsSlice = {
  windowDays: number;
  statusCounts: Partial<Record<CommandStatus, number>>;
  deliveryTimeoutCount: number;
  verifyTimeoutRefreshCount: number;
  lateConfirmationCount: number;
  deviceBusyRejectCount: number;
};

/**
 * Per-device operational truth for maintenance UI (derived from devices + latest_state + commands).
 */
export const buildDeviceOperationalShadow = async (
  pool: Pool,
  sn: string
): Promise<DeviceOperationalShadow | null> => {
  const device = await getDeviceBySn(pool, sn);
  if (!device) {
    return null;
  }
  const latest = await getLatestStateBySn(pool, sn);
  const inFlight = await getInFlightCommandForDevice(pool, sn);
  const policy = await getEffectivePolicyForDevice(pool, {
    sn,
    productKey: device.product_key,
    commandType: null
  });
  const orch = describeEffectiveCommandOrchestration(policy.profile);
  const telemetryCycleSecEffective = Number(orch.telemetryCycleSec ?? 300);

  const lastAck = await pool.query<{ m: string | null }>(
    `SELECT MAX(ack_at)::text AS m FROM commands WHERE sn = $1 AND ack_at IS NOT NULL`,
    [sn]
  );
  const lastVer = await pool.query<{ m: string | null }>(
    `SELECT MAX(verified_at)::text AS m
     FROM commands
     WHERE sn = $1 AND verified_at IS NOT NULL`,
    [sn]
  );
  const lastRefOk = await pool.query<{ m: string | null }>(
    `SELECT MAX(verified_at)::text AS m
     FROM commands
     WHERE sn = $1
       AND command_type = 'refresh'
       AND status IN ('verified_success', 'verified_success_with_late_confirmation')`,
    [sn]
  );
  const lastSwOk = await pool.query<{ m: string | null }>(
    `SELECT MAX(verified_at)::text AS m
     FROM commands
     WHERE sn = $1
       AND command_type IN ('force_switch_0', 'force_switch_1')
       AND status IN ('verified_success', 'verified_success_with_late_confirmation')`,
    [sn]
  );

  return {
    sn,
    desiredSwitchState: desiredFromCommand(inFlight),
    observedSwitchState: readObservedSwitchFromSummary(latest?.last_summary ?? null),
    lastSeenAt: device.last_seen_at ?? null,
    lastAckAt: lastAck.rows[0]?.m ?? null,
    lastVerifiedAt: lastVer.rows[0]?.m ?? null,
    activeCommandId: inFlight?.id ?? null,
    activeCommandStatus: inFlight?.status ?? null,
    deviceBusyUntil: inFlight?.expires_at ?? null,
    telemetryCycleSecEffective,
    lastRefreshSuccessAt: lastRefOk.rows[0]?.m ?? null,
    lastSwitchSuccessAt: lastSwOk.rows[0]?.m ?? null
  };
};

export const aggregateCommandOrchestrationMetrics = async (
  pool: Pool,
  sn: string,
  windowDays = 7
): Promise<CommandOrchestrationMetricsSlice> => {
  const statusResult = await pool.query<{ status: CommandStatus; c: string }>(
    `SELECT status, COUNT(*)::bigint AS c
     FROM commands
     WHERE sn = $1
       AND created_at > NOW() - ($2::float * interval '1 day')
     GROUP BY status`,
    [sn, windowDays]
  );
  const statusCounts: Partial<Record<CommandStatus, number>> = {};
  for (const row of statusResult.rows) {
    statusCounts[row.status] = Number(row.c);
  }
  const deliveryTimeoutCount = statusCounts.delivery_timeout ?? 0;
  const verifyTimeoutRefreshCount = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::bigint AS c
     FROM commands
     WHERE sn = $1
       AND command_type = 'refresh'
       AND status = 'failed'
       AND created_at > NOW() - ($2::float * interval '1 day')
       AND COALESCE(error_message, '') LIKE '%verify_timeout%'`,
    [sn, windowDays]
  );
  const lateQ = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::bigint AS c
     FROM commands
     WHERE sn = $1
       AND status = 'verified_success_with_late_confirmation'
       AND created_at > NOW() - ($2::float * interval '1 day')`,
    [sn, windowDays]
  );

  return {
    windowDays,
    statusCounts,
    deliveryTimeoutCount,
    verifyTimeoutRefreshCount: Number(verifyTimeoutRefreshCount.rows[0]?.c ?? 0),
    lateConfirmationCount: Number(lateQ.rows[0]?.c ?? 0),
    deviceBusyRejectCount: 0
  };
};

export const buildMaintenanceUiSections = (
  profile: import("./types.js").CommandPolicyProfileRow,
  resolved: Record<string, unknown>
): Record<string, unknown> => ({
  commandPolicy: {
    profileCode: profile.code,
    ackTimeoutSec: resolved.ackTimeoutSec,
    maxAttempts: resolved.maxAttempts,
    quickRetrySeconds: resolved.quickRetrySeconds,
    commandTtlSec: resolved.commandTtlSec
  },
  verifyStrategy: {
    verifyTimeoutSec: resolved.verifyTimeoutSec,
    telemetryCycleSec: resolved.telemetryCycleSec,
    lateConfirmationWindowSec: resolved.lateConfirmationWindowSec,
    effectiveVerifyWaitSec: resolved.effectiveVerifyWaitSec,
    parentFinalizeFromChildRefresh: resolved.parentFinalizeFromChildRefresh ?? true,
    parentLateSuccessEnabled: resolved.parentLateSuccessEnabled ?? true
  },
  pipelineControl: {
    singleFlightEnabled: resolved.singleFlightEnabled,
    deviceBusyMode: resolved.deviceBusyMode,
    retryBackoffMode: resolved.retryBackoffMode,
    retryJitterPct: resolved.retryJitterPct,
    autoRefreshAfterSwitchEnabled: resolved.autoRefreshAfterSwitchEnabled ?? true,
    autoRefreshDelaySec: resolved.autoRefreshDelaySec ?? 0
  },
  rateBudget: {
    refreshBudgetPerHour: resolved.refreshBudgetPerHour,
    switchBudgetPerHour: resolved.switchBudgetPerHour
  },
  liveDiagnostics: {
    note: "Use deviceShadow + recentCommandsSummary; start diagnostic runs via POST /devices/:sn/diagnostics"
  },
  metrics: {
    note: "Worker emits orchestration_metrics_snapshot; API aggregates command rows in metrics slice"
  }
});

export const getRecentCommandsSummary = async (
  pool: Pool,
  sn: string,
  limit = 30
): Promise<CommandRow[]> => listCommandsBySn(pool, sn, limit);
