import type { CommandRow } from "@communication/db";
import { parseCommandPolicySnapshot } from "./command-lifecycle.js";

export type ParentVerifySource =
  | "refresh_ack"
  | "latest_state_update"
  | "timeout"
  | "child_refresh"
  | "late_telemetry"
  | "child_substantive_ack"
  | "recovery_refresh_timeout"
  | "recovery_parent_deadline"
  | "recovery_after_child_timeout"
  | "recovery_parent_deadline_evidence";

/**
 * Stable JSON-friendly fields for real-device command debugging (worker logs + SQL cross-check).
 */
export const commandObservabilityFields = (command: CommandRow): Record<string, unknown> => {
  const policy = parseCommandPolicySnapshot(command.policy_snapshot);
  return {
    commandId: command.id,
    parentCommandId: command.parent_command_id ?? null,
    sn: command.sn,
    productKey: command.product_key,
    commandType: command.command_type,
    status: command.status,
    attemptCount: command.attempt_count,
    msgid: command.msgid,
    ackTimeoutSec: policy.ackTimeoutSec,
    verifyTimeoutSec: policy.verifyTimeoutSec,
    ackRetryMinDelaySec: policy.ackRetryMinDelaySec,
    telemetryCycleSec: policy.telemetryCycleSec,
    lateConfirmationWindowSec: policy.lateConfirmationWindowSec,
    retryBackoffMode: policy.retryBackoffMode,
    retryJitterPct: policy.retryJitterPct,
    singleFlightEnabled: policy.singleFlightEnabled,
    nextAttemptAt: command.next_attempt_at ?? null,
    expiresAt: command.expires_at ?? null,
    publishedAt: command.published_at ?? null,
    ackAt: command.ack_at ?? null,
    verifiedAt: command.verified_at ?? null,
    completedAt: command.completed_at ?? null
  };
};

export const logCommandLifecycle = (
  phase: string,
  fields: Record<string, unknown>,
  extra?: Record<string, unknown>
): void => {
  console.log(`[mqtt-worker][command] ${phase}`, extra ? { ...fields, ...extra } : fields);
};

export const logParentSwitchVerifyClosed = (
  parent: CommandRow,
  ctx: {
    verifySource: ParentVerifySource;
    expectedSwitch: number;
    actualSwitch: number | null;
    finalStatus: string;
  }
): void => {
  console.log("[mqtt-worker][command] parent_switch_verify_closed", {
    ...commandObservabilityFields(parent),
    verifySource: ctx.verifySource,
    expectedSwitchSta: ctx.expectedSwitch,
    actualSwitchSta: ctx.actualSwitch,
    finalStatus: ctx.finalStatus
  });
};
