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
  /**
   * While the device is ONLINE, the (near-constant) gap between successive reconcile attempts.
   * Note: a sleeping meter only receives when it wakes (wake-triggered delivery handles that);
   * this is the timer-fallback cadence + how fast we re-issue once a command goes terminal.
   */
  onlineRetryIntervalSec: number;
  /** After this many attempts while ONLINE without reconciling, raise the "not actuating" alarm. */
  onlineFailAlarmAttempts: number;
  /** When false, staying offline raises no alarm (offline is "expected"); desired state is kept. */
  offlineAlarmEnabled: boolean;
}

export interface ReconcilerDeps {
  pool: Pool;
  log: Logger;
  /** Reuses the worker's proven SwitchSta extraction from latest_state. */
  resolveReportedSwitch: (sn: string) => Promise<number | null>;
  config: ReconcilerConfig;
  /** Optional hook fired when a desired state has been unreachable past its alarm threshold. */
  onUnreachableAlarm?: (info: { sn: string; desired: number; unreachableForSec: number }) => void;
  /** Fired once when an ONLINE device has failed to actuate after onlineFailAlarmAttempts tries. */
  onOnlineFailAlarm?: (info: { sn: string; desired: number; attempts: number }) => void;
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

export interface ReconcileStepPlan {
  /** Milliseconds until the reconciler should look at this row again. */
  nextEvalMs: number;
  /** True exactly on the attempt that crosses the online-fail threshold (fires the alarm once). */
  emitOnlineFailAlarm: boolean;
}

/**
 * Pure timing/alarm policy for one reconcile pass. Kept separate from the DB orchestration so the
 * "fast online cadence + alarm after N online attempts + offline backoff" rules are unit-testable.
 *
 *  - online actions (issue_command / wait_in_flight): near-constant fast cadence so a reachable
 *    device is re-driven promptly (the operator-approved 7s default).
 *  - unreachable (offline): capped exponential backoff (cheap polling; delivery happens on wake).
 *  - issue_command crossing `onlineFailAlarmAttempts` raises the one-shot "not actuating" alarm.
 */
export const planReconcileStep = (input: {
  action: ReconcileAction;
  /** attempt_count BEFORE this pass (issue_command will make it attemptCount + 1). */
  attemptCount: number;
  onlineRetryIntervalSec: number;
  onlineFailAlarmAttempts: number;
  offlineMinBackoffSec: number;
  offlineMaxBackoffSec: number;
  jitterPct: number;
}): ReconcileStepPlan => {
  const onlineMs = Math.max(1, input.onlineRetryIntervalSec) * 1000;
  switch (input.action) {
    case "reconciled":
      return { nextEvalMs: 0, emitOnlineFailAlarm: false };
    case "unreachable":
      return {
        nextEvalMs: computeBackoffMs(
          input.attemptCount + 1,
          input.offlineMinBackoffSec,
          input.offlineMaxBackoffSec,
          input.jitterPct
        ),
        emitOnlineFailAlarm: false
      };
    case "wait_in_flight":
      return { nextEvalMs: onlineMs, emitOnlineFailAlarm: false };
    case "issue_command":
      return {
        nextEvalMs: onlineMs,
        emitOnlineFailAlarm: input.attemptCount + 1 === input.onlineFailAlarmAttempts
      };
    default:
      return { nextEvalMs: onlineMs, emitOnlineFailAlarm: false };
  }
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
      const plan = planReconcileStep({
        action,
        attemptCount: row.attempt_count,
        onlineRetryIntervalSec: config.onlineRetryIntervalSec,
        onlineFailAlarmAttempts: config.onlineFailAlarmAttempts,
        offlineMinBackoffSec: minSec,
        offlineMaxBackoffSec: maxSec,
        jitterPct: config.jitterPct
      });

      if (action === "reconciled") {
        await markDesiredReconciled(pool, row.id, { switch: reported });
        log.info("reconcile_done", { id: row.id, sn: row.sn, desired, reported });
        continue;
      }

      if (action === "unreachable") {
        const backoffMs = plan.nextEvalMs;
        await markDesiredUnreachable(pool, row.id, new Date(Date.now() + backoffMs));
        const unreachableForSec = row.unreachable_since
          ? (Date.now() - new Date(row.unreachable_since).getTime()) / 1000
          : 0;
        // Offline is treated as "expected": the irade is kept and retried on wake, but we only
        // emit an offline alarm when explicitly enabled. The important fault — online but not
        // actuating — is handled in the issue_command branch below.
        if (config.offlineAlarmEnabled && unreachableForSec >= alarmSec && row.last_command_id) {
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
        // Online + a command already in flight: re-check at the fast online cadence (single-flight
        // prevents issuing a duplicate command; this just keeps us responsive once it terminates).
        const waitMs = plan.nextEvalMs;
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

      // issue_command (device is online + state is wrong + nothing in flight)
      const command = await createReconcileSwitchCommand(pool, row, desired);
      const nextAttempt = row.attempt_count + 1;
      // Online retries run at a near-constant fast cadence (not 30→300s backoff): the device is
      // reachable, so we want to re-drive promptly each time a command goes terminal.
      const nextEvalMs = plan.nextEvalMs;
      await markDesiredInFlight(pool, row.id, {
        commandId: command.id,
        incrementAttempt: true,
        nextEvalAt: new Date(Date.now() + nextEvalMs)
      });
      await addCommandEvent(pool, command.id, "reconcile_command_issued", {
        sn: row.sn,
        desired,
        desiredStateId: row.id,
        attempt: nextAttempt
      });
      log.info("reconcile_command_issued", {
        id: row.id,
        sn: row.sn,
        desired,
        commandId: command.id,
        attempt: nextAttempt
      });

      // Online but still not actuating after the configured number of attempts → fault alarm.
      // Fires exactly once (on the threshold attempt); the irade is NOT dropped — we keep trying.
      if (plan.emitOnlineFailAlarm) {
        await addCommandEvent(pool, command.id, "desired_state_online_not_actuating_alarm", {
          sn: row.sn,
          desired,
          attempts: nextAttempt
        });
        deps.onOnlineFailAlarm?.({ sn: row.sn, desired, attempts: nextAttempt });
        log.warn("reconcile_online_not_actuating_alarm", {
          id: row.id,
          sn: row.sn,
          desired,
          attempts: nextAttempt
        });
      }
    } catch (error) {
      log.error("reconcile_row_failed", {
        id: row.id,
        sn: row.sn,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
};
