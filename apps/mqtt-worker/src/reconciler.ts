import { generateCommandMsgid, type Logger } from "@communication/core";
import {
  addCommandEvent,
  claimDueDesiredStates,
  createCommand,
  getActiveSwitchCommandForDevice,
  getEffectivePolicyForDevice,
  markDesiredInFlight,
  markDesiredReconciled,
  markDesiredUnreachable,
  resolveDeviceOnline,
  type CommandRow,
  type DeviceDesiredStateRow,
  type Pool
} from "@communication/db";

export interface ReconcilerConfig {
  onlineTtlSec: number;
  defaultMinBackoffSec: number;
  defaultMaxBackoffSec: number;
  defaultUnreachableAlarmSec: number;
  jitterPct: number;
}

export interface ReconcilerDeps {
  pool: Pool;
  log: Logger;
  /** Reuses the worker's proven SwitchSta extraction from latest_state. */
  resolveReportedSwitch: (sn: string) => Promise<number | null>;
  config: ReconcilerConfig;
  /** Optional hook fired when a desired state has been unreachable past its alarm threshold. */
  onUnreachableAlarm?: (info: { sn: string; desired: number; unreachableForSec: number }) => void;
}

export type ReconcileAction = "reconciled" | "unreachable" | "wait_in_flight" | "issue_command";

/** Pure decision: success first, then reachability, then single-flight, else issue. */
export const decideReconcileAction = (input: {
  reported: number | null;
  desired: number;
  online: boolean;
  hasInFlight: boolean;
}): ReconcileAction => {
  if (input.reported !== null && input.reported === input.desired) {
    return "reconciled";
  }
  if (!input.online) {
    return "unreachable";
  }
  if (input.hasInFlight) {
    return "wait_in_flight";
  }
  return "issue_command";
};

/** Capped exponential backoff with symmetric jitter, clamped to [minSec, maxSec]. */
export const computeBackoffMs = (
  attempt: number,
  minSec: number,
  maxSec: number,
  jitterPct: number
): number => {
  const min = Math.max(1, minSec);
  const max = Math.max(min, maxSec);
  const exp = Math.min(max, min * Math.pow(2, Math.max(0, attempt - 1)));
  const j = Math.min(100, Math.max(0, jitterPct)) / 100;
  if (j <= 0) {
    return Math.round(exp * 1000);
  }
  const lo = exp * (1 - j);
  const hi = exp * (1 + j);
  const withJitter = lo + Math.random() * (hi - lo);
  const clamped = Math.min(max, Math.max(min, withJitter));
  return Math.round(clamped * 1000);
};

const readDesiredSwitch = (row: DeviceDesiredStateRow): number | null => {
  const v = (row.desired_value as { switch?: unknown } | null)?.switch;
  if (v === 0 || v === "0") {
    return 0;
  }
  if (v === 1 || v === "1") {
    return 1;
  }
  return null;
};

const policyBackoff = (
  policy: Record<string, unknown>,
  cfg: ReconcilerConfig
): { minSec: number; maxSec: number; alarmSec: number } => {
  const num = (k: string, fallback: number): number => {
    const raw = policy[k];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  };
  return {
    minSec: num("reconcile_min_backoff_sec", cfg.defaultMinBackoffSec),
    maxSec: num("reconcile_max_backoff_sec", cfg.defaultMaxBackoffSec),
    alarmSec: num("reconcile_unreachable_alarm_sec", cfg.defaultUnreachableAlarmSec)
  };
};

const createReconcileSwitchCommand = async (
  pool: Pool,
  row: DeviceDesiredStateRow,
  desired: number
): Promise<CommandRow> => {
  const productKey = row.product_key ?? "";
  const policyView = await getEffectivePolicyForDevice(pool, {
    sn: row.sn,
    productKey: row.product_key,
    commandType: desired === 0 ? "force_switch_0" : "force_switch_1"
  });
  const profile = policyView.profile;
  const ttlSec = profile.command_ttl_sec ?? 300;
  return createCommand(pool, {
    sn: row.sn,
    productKey,
    commandType: desired === 0 ? "force_switch_0" : "force_switch_1",
    method: "operate",
    msgid: generateCommandMsgid(),
    requestPayload: {
      commandType: desired === 0 ? "force_switch_0" : "force_switch_1",
      switchTarget: desired,
      reason: "reconcile",
      desiredStateId: row.id
    },
    expiresAt: new Date(Date.now() + ttlSec * 1000),
    policySnapshot: profile
  });
};

/**
 * One reconciler pass: for each due desired-state row, drive device toward desired value.
 * Never gives up (forever-until-cancel): unreachable rows are re-armed with capped backoff and
 * resume immediately when presence/telemetry returns.
 */
export const processDesiredStateReconciliation = async (deps: ReconcilerDeps): Promise<void> => {
  const { pool, log, resolveReportedSwitch, config } = deps;
  let rows: DeviceDesiredStateRow[];
  try {
    rows = await claimDueDesiredStates(pool, 200);
  } catch (error) {
    log.error("reconcile_list_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  for (const row of rows) {
    try {
      const desired = readDesiredSwitch(row);
      if (desired === null) {
        log.warn("reconcile_invalid_desired_value", { id: row.id, sn: row.sn });
        continue;
      }

      const reported = await resolveReportedSwitch(row.sn);
      const online = await resolveDeviceOnline(pool, row.sn, config.onlineTtlSec);
      const inFlight = await getActiveSwitchCommandForDevice(pool, row.sn);
      const action = decideReconcileAction({
        reported,
        desired,
        online,
        hasInFlight: inFlight !== null
      });

      const policyView = await getEffectivePolicyForDevice(pool, {
        sn: row.sn,
        productKey: row.product_key
      });
      const { minSec, maxSec, alarmSec } = policyBackoff(
        policyView.profile as unknown as Record<string, unknown>,
        config
      );

      if (action === "reconciled") {
        await markDesiredReconciled(pool, row.id, { switch: reported });
        log.info("reconcile_done", { id: row.id, sn: row.sn, desired, reported });
        continue;
      }

      if (action === "unreachable") {
        const backoffMs = computeBackoffMs(row.attempt_count + 1, minSec, maxSec, config.jitterPct);
        await markDesiredUnreachable(pool, row.id, new Date(Date.now() + backoffMs));
        const unreachableForSec = row.unreachable_since
          ? (Date.now() - new Date(row.unreachable_since).getTime()) / 1000
          : 0;
        if (unreachableForSec >= alarmSec && row.last_command_id) {
          await addCommandEvent(pool, row.last_command_id, "desired_state_unreachable_alarm", {
            sn: row.sn,
            desired,
            unreachableForSec: Math.round(unreachableForSec)
          });
          deps.onUnreachableAlarm?.({ sn: row.sn, desired, unreachableForSec: Math.round(unreachableForSec) });
        }
        log.warn("reconcile_unreachable", {
          id: row.id,
          sn: row.sn,
          desired,
          backoffMs,
          attempt: row.attempt_count
        });
        continue;
      }

      if (action === "wait_in_flight") {
        const waitMs = computeBackoffMs(1, minSec, maxSec, config.jitterPct);
        await markDesiredInFlight(pool, row.id, {
          commandId: inFlight?.id ?? null,
          incrementAttempt: false,
          nextEvalAt: new Date(Date.now() + waitMs)
        });
        log.debug("reconcile_wait_in_flight", {
          id: row.id,
          sn: row.sn,
          blockingCommandId: inFlight?.id ?? null,
          blockingStatus: inFlight?.status ?? null
        });
        continue;
      }

      // issue_command
      const command = await createReconcileSwitchCommand(pool, row, desired);
      const backoffMs = computeBackoffMs(row.attempt_count + 1, minSec, maxSec, config.jitterPct);
      await markDesiredInFlight(pool, row.id, {
        commandId: command.id,
        incrementAttempt: true,
        nextEvalAt: new Date(Date.now() + backoffMs)
      });
      await addCommandEvent(pool, command.id, "reconcile_command_issued", {
        sn: row.sn,
        desired,
        desiredStateId: row.id,
        attempt: row.attempt_count + 1
      });
      log.info("reconcile_command_issued", {
        id: row.id,
        sn: row.sn,
        desired,
        commandId: command.id,
        attempt: row.attempt_count + 1
      });
    } catch (error) {
      log.error("reconcile_row_failed", {
        id: row.id,
        sn: row.sn,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
};
