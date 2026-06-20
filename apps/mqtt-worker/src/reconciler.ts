import { generateCommandMsgid, type Logger } from "@communication/core";
import {
  ALARM_COMMAND_CONFIRMATION_TIMEOUT,
  addCommandEvent,
  claimDueDesiredStates,
  clearAlarms,
  createCommand,
  getActiveSwitchCommandForDevice,
  getEffectivePolicyForDevice,
  markDesiredInFlight,
  markDesiredNeedsAttention,
  markDesiredReconciled,
  markDesiredUnreachable,
  raiseAlarm,
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
  /** When false, staying offline raises no alarm (offline is "expected"); desired state is kept. */
  offlineAlarmEnabled: boolean;
  /** Bounded retry: number of cycles to attempt while online before needs_attention + alarm. */
  cycleCount: number;
  /** Signals (republishes) per cycle — drives the per-cycle delivery window. */
  signalsPerCycle: number;
  /** Per-cycle signal interval (sec). Overflow cycles reuse the last value. e.g. [10,10,7]. */
  cycleIntervalsSec: number[];
}

export interface ReconcilerDeps {
  pool: Pool;
  log: Logger;
  /** Reuses the worker's proven SwitchSta extraction from latest_state. */
  resolveReportedSwitch: (sn: string) => Promise<number | null>;
  config: ReconcilerConfig;
  /** Optional hook fired when a desired state has been unreachable past its alarm threshold. */
  onUnreachableAlarm?: (info: { sn: string; desired: number; unreachableForSec: number }) => void;
  /**
   * Fired once when an ONLINE device exhausts all command cycles without confirming the new state
   * (COMMAND_CONFIRMATION_TIMEOUT). The desired state is kept (needs_attention) for later retry.
   */
  onCommandConfirmationTimeout?: (info: { sn: string; desired: number; cycles: number }) => void;
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
}

/**
 * Pure timing policy for one reconcile pass. Kept separate from the DB orchestration so the
 * "fast online cadence vs. offline backoff" rule is unit-testable.
 *
 *  - online actions (issue_command / wait_in_flight): near-constant fast cadence so a reachable
 *    device is re-driven promptly (operator-approved 7s default) and confirmation is caught fast.
 *  - unreachable (offline): capped exponential backoff (cheap polling; delivery happens on wake).
 */
export const planReconcileStep = (input: {
  action: ReconcileAction;
  /** attempt_count BEFORE this pass. */
  attemptCount: number;
  onlineRetryIntervalSec: number;
  offlineMinBackoffSec: number;
  offlineMaxBackoffSec: number;
  jitterPct: number;
}): ReconcileStepPlan => {
  const onlineMs = Math.max(1, input.onlineRetryIntervalSec) * 1000;
  switch (input.action) {
    case "reconciled":
      return { nextEvalMs: 0 };
    case "unreachable":
      return {
        nextEvalMs: computeBackoffMs(
          input.attemptCount + 1,
          input.offlineMinBackoffSec,
          input.offlineMaxBackoffSec,
          input.jitterPct
        )
      };
    case "wait_in_flight":
    case "issue_command":
    default:
      return { nextEvalMs: onlineMs };
  }
};

export interface SwitchCyclePlan {
  /** "issue" → run this cycle; "exhausted" → all cycles spent without confirmation. */
  kind: "issue" | "exhausted";
  /** 1-based cycle index to issue (valid when kind === "issue"). */
  cycleNo: number;
  intervalSec: number;
  signalsPerCycle: number;
  /** Bounded delivery window for the cycle command = intervalSec * signalsPerCycle. */
  deliveryWindowSec: number;
  /** Per-command timing so intra-command republish spacing ≈ intervalSec (ack + retry ≈ interval). */
  ackTimeoutSec: number;
  retryIntervalSec: number;
}

/**
 * Pure bounded-cycle planner for a switch reconcile. Each cycle is one issued command that
 * republishes `signalsPerCycle` times across a window of `intervalSec * signalsPerCycle` seconds.
 * After `cycleCount` cycles the budget is exhausted (→ caller raises COMMAND_CONFIRMATION_TIMEOUT
 * and parks the desired state in needs_attention; it is NOT dropped).
 */
export const planSwitchCycle = (input: {
  /** cycle_no currently recorded on the desired state (0 = none issued yet). */
  currentCycleNo: number;
  cycleCount: number;
  signalsPerCycle: number;
  cycleIntervalsSec: number[];
}): SwitchCyclePlan => {
  const cycleCount = Math.max(1, Math.floor(input.cycleCount));
  const next = input.currentCycleNo + 1;
  if (next > cycleCount) {
    return {
      kind: "exhausted",
      cycleNo: input.currentCycleNo,
      intervalSec: 0,
      signalsPerCycle: 0,
      deliveryWindowSec: 0,
      ackTimeoutSec: 0,
      retryIntervalSec: 0
    };
  }
  const intervals = input.cycleIntervalsSec.length ? input.cycleIntervalsSec : [10];
  const intervalSec = Math.max(1, Math.floor(intervals[Math.min(next - 1, intervals.length - 1)] ?? 10));
  const signals = Math.max(1, Math.floor(input.signalsPerCycle));
  return {
    kind: "issue",
    cycleNo: next,
    intervalSec,
    signalsPerCycle: signals,
    deliveryWindowSec: intervalSec * signals,
    ackTimeoutSec: Math.max(1, Math.ceil(intervalSec / 2)),
    retryIntervalSec: Math.max(1, Math.floor(intervalSec / 2))
  };
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
  desired: number,
  cycle: SwitchCyclePlan
): Promise<CommandRow> => {
  const productKey = row.product_key ?? "";
  const policyView = await getEffectivePolicyForDevice(pool, {
    sn: row.sn,
    productKey: row.product_key,
    commandType: desired === 0 ? "force_switch_0" : "force_switch_1"
  });
  // Per-cycle timing override: the command republishes ~signalsPerCycle times at ~intervalSec
  // spacing across a bounded delivery window, then goes delivery_timeout → next cycle.
  const profile = {
    ...policyView.profile,
    ack_timeout_sec: cycle.ackTimeoutSec,
    retry_interval_sec: cycle.retryIntervalSec,
    ack_retry_min_delay_sec: 1,
    delivery_window_sec: cycle.deliveryWindowSec,
    max_attempts: Math.max(policyView.profile.max_attempts ?? 0, cycle.signalsPerCycle + 1)
  };
  // Command must outlive its delivery window so it is not expired pre-publish.
  const ttlSec = Math.max(profile.command_ttl_sec ?? 300, cycle.deliveryWindowSec + 30);
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
      desiredStateId: row.id,
      cycleNo: cycle.cycleNo
    },
    expiresAt: new Date(Date.now() + ttlSec * 1000),
    policySnapshot: profile
  });
};

/** Resolve cycle config from the effective policy profile, falling back to reconciler config. */
const resolveCycleConfig = (
  policy: Record<string, unknown>,
  cfg: ReconcilerConfig
): { cycleCount: number; signalsPerCycle: number; cycleIntervalsSec: number[] } => {
  const intRaw = policy["command_cycle_intervals_sec"];
  const intervals = Array.isArray(intRaw)
    ? intRaw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const num = (k: string, fallback: number): number => {
    const raw = policy[k];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  return {
    cycleCount: num("command_cycle_count", cfg.cycleCount),
    signalsPerCycle: num("command_signals_per_cycle", cfg.signalsPerCycle),
    cycleIntervalsSec: intervals.length ? intervals : cfg.cycleIntervalsSec
  };
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
        offlineMinBackoffSec: minSec,
        offlineMaxBackoffSec: maxSec,
        jitterPct: config.jitterPct
      });

      if (action === "reconciled") {
        await markDesiredReconciled(pool, row.id, { switch: reported });
        // Confirmed at last: clear any open confirmation-timeout alarm for this device.
        await clearAlarms(pool, row.sn, ALARM_COMMAND_CONFIRMATION_TIMEOUT);
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

      // issue_command (device is online + state is wrong + nothing in flight): drive the next cycle.
      const cycleCfg = resolveCycleConfig(
        policyView.profile as unknown as Record<string, unknown>,
        config
      );
      const cycle = planSwitchCycle({
        currentCycleNo: row.cycle_no,
        cycleCount: cycleCfg.cycleCount,
        signalsPerCycle: cycleCfg.signalsPerCycle,
        cycleIntervalsSec: cycleCfg.cycleIntervalsSec
      });

      if (cycle.kind === "exhausted") {
        // Online but never confirmed the new state across all cycles → COMMAND_CONFIRMATION_TIMEOUT.
        // Keep the desired state (needs_attention); it resumes on next wake or operator retry.
        await markDesiredNeedsAttention(pool, row.id);
        await raiseAlarm(pool, {
          sn: row.sn,
          alarmType: ALARM_COMMAND_CONFIRMATION_TIMEOUT,
          severity: "warning",
          commandId: row.last_command_id,
          desiredStateId: row.id,
          message: "Cihaza aç/kapat komutu gönderildi ancak cihazdan durum doğrulaması alınamadı.",
          fields: { desired, cycles: cycleCfg.cycleCount, signalsPerCycle: cycleCfg.signalsPerCycle }
        });
        if (row.last_command_id) {
          await addCommandEvent(pool, row.last_command_id, "command_confirmation_timeout", {
            sn: row.sn,
            desired,
            cycles: cycleCfg.cycleCount
          });
        }
        deps.onCommandConfirmationTimeout?.({ sn: row.sn, desired, cycles: cycleCfg.cycleCount });
        log.warn("reconcile_command_confirmation_timeout", {
          id: row.id,
          sn: row.sn,
          desired,
          cycles: cycleCfg.cycleCount
        });
        continue;
      }

      const command = await createReconcileSwitchCommand(pool, row, desired, cycle);
      const nextAttempt = row.attempt_count + 1;
      // Re-check at the fast online cadence while this cycle's command runs; on terminal (no
      // confirmation) the next pass issues the following cycle until the budget is exhausted.
      await markDesiredInFlight(pool, row.id, {
        commandId: command.id,
        incrementAttempt: true,
        cycleNo: cycle.cycleNo,
        nextEvalAt: new Date(Date.now() + plan.nextEvalMs)
      });
      await addCommandEvent(pool, command.id, "reconcile_command_issued", {
        sn: row.sn,
        desired,
        desiredStateId: row.id,
        attempt: nextAttempt,
        cycle: cycle.cycleNo,
        signalsPerCycle: cycle.signalsPerCycle,
        intervalSec: cycle.intervalSec,
        deliveryWindowSec: cycle.deliveryWindowSec
      });
      log.info("reconcile_command_issued", {
        id: row.id,
        sn: row.sn,
        desired,
        commandId: command.id,
        attempt: nextAttempt,
        cycle: cycle.cycleNo
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
