/**
 * Pure helpers for command policy parsing and SwitchSta extraction from ack/update payloads.
 * Kept separate from MQTT/DB wiring for focused testing (no telemetry parser changes).
 */

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const toFiniteSwitch = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export type RetryBackoffMode = "fixed" | "linear" | "exponential";

export type ParsedCommandPolicy = {
  ackTimeoutSec: number;
  verifyTimeoutSec: number;
  quickRetrySeconds: number[];
  maxAttempts: number;
  ackRetryMinDelaySec: number;
  telemetryCycleSec: number;
  lateConfirmationWindowSec: number;
  retryBackoffMode: RetryBackoffMode;
  retryJitterPct: number;
  singleFlightEnabled: boolean;
  autoRefreshAfterSwitchEnabled: boolean;
  autoRefreshDelaySec: number;
  parentFinalizeFromChildRefresh: boolean;
  parentLateSuccessEnabled: boolean;
  /** Fixed seconds between republish while awaiting ACK (same command). */
  retryIntervalSec: number;
  /** Total seconds from first publish (anchor) before delivery fails. */
  deliveryWindowSec: number;
  raiseCommunicationFaultEnabled: boolean;
  faultIfOnlineButNoAckAfterSec: number | null;
  faultIfOnlineButNoVerifyAfterSec: number | null;
};

const defaultQuickRetry = [0, 3, 8, 20];

const parseBackoffMode = (raw: unknown): RetryBackoffMode => {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "exponential") {
    return "exponential";
  }
  if (s === "linear") {
    return "linear";
  }
  if (s === "fixed" || s === "schedule_plus_jitter") {
    return "fixed";
  }
  return "fixed";
};

export const parseCommandPolicySnapshot = (snapshot: unknown): ParsedCommandPolicy => {
  const o = asObject(snapshot);
  const ackTimeoutSec =
    typeof o?.ack_timeout_sec === "number" && Number.isFinite(o.ack_timeout_sec)
      ? Math.max(1, Math.floor(o.ack_timeout_sec))
      : 4;
  const verifyTimeoutSec =
    typeof o?.verify_timeout_sec === "number" && Number.isFinite(o.verify_timeout_sec)
      ? Math.max(1, Math.floor(o.verify_timeout_sec))
      : 90;
  const maxAttempts =
    typeof o?.max_attempts === "number" && Number.isFinite(o.max_attempts)
      ? Math.max(1, Math.floor(o.max_attempts))
      : 7;

  let quickRetrySeconds = defaultQuickRetry;
  const rawQuick = o?.quick_retry_seconds;
  if (Array.isArray(rawQuick)) {
    const parsed = rawQuick
      .map((x) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : NaN))
      .filter((x) => !Number.isNaN(x));
    if (parsed.length > 0) {
      quickRetrySeconds = parsed;
    }
  }

  const ackRetryMinDelaySec =
    typeof o?.ack_retry_min_delay_sec === "number" && Number.isFinite(o.ack_retry_min_delay_sec)
      ? Math.max(0, o.ack_retry_min_delay_sec)
      : 5;
  const telemetryCycleSec =
    typeof o?.telemetry_cycle_sec === "number" && Number.isFinite(o.telemetry_cycle_sec)
      ? Math.max(60, Math.floor(o.telemetry_cycle_sec))
      : 300;
  const lateConfirmationWindowSec =
    typeof o?.late_confirmation_window_sec === "number" && Number.isFinite(o.late_confirmation_window_sec)
      ? Math.max(60, Math.floor(o.late_confirmation_window_sec))
      : 3600;
  const retryJitterPct =
    typeof o?.retry_jitter_pct === "number" && Number.isFinite(o.retry_jitter_pct)
      ? Math.min(100, Math.max(0, Math.floor(o.retry_jitter_pct)))
      : 20;
  const retryBackoffMode = parseBackoffMode(o?.retry_backoff_mode);
  const singleFlightEnabled =
    typeof o?.single_flight_enabled === "boolean" ? o.single_flight_enabled : true;
  const autoRefreshAfterSwitchEnabled =
    typeof o?.auto_refresh_after_switch_enabled === "boolean"
      ? o.auto_refresh_after_switch_enabled
      : true;
  const autoRefreshDelaySec =
    typeof o?.auto_refresh_delay_sec === "number" && Number.isFinite(o.auto_refresh_delay_sec)
      ? Math.max(0, Math.floor(o.auto_refresh_delay_sec))
      : 0;
  const parentFinalizeFromChildRefresh =
    typeof o?.parent_finalize_from_child_refresh === "boolean"
      ? o.parent_finalize_from_child_refresh
      : true;
  const parentLateSuccessEnabled =
    typeof o?.parent_late_success_enabled === "boolean" ? o.parent_late_success_enabled : true;

  const retryIntervalSec =
    typeof o?.retry_interval_sec === "number" && Number.isFinite(o.retry_interval_sec)
      ? Math.max(1, Math.floor(o.retry_interval_sec))
      : 30;
  const deliveryWindowSec =
    typeof o?.delivery_window_sec === "number" && Number.isFinite(o.delivery_window_sec)
      ? Math.max(1, Math.floor(o.delivery_window_sec))
      : 720;
  const raiseCommunicationFaultEnabled =
    typeof o?.raise_communication_fault_enabled === "boolean"
      ? o.raise_communication_fault_enabled
      : false;
  const faultIfOnlineButNoAckAfterSec =
    typeof o?.fault_if_online_but_no_ack_after_sec === "number" &&
    Number.isFinite(o.fault_if_online_but_no_ack_after_sec)
      ? Math.max(1, Math.floor(o.fault_if_online_but_no_ack_after_sec))
      : null;
  const faultIfOnlineButNoVerifyAfterSec =
    typeof o?.fault_if_online_but_no_verify_after_sec === "number" &&
    Number.isFinite(o.fault_if_online_but_no_verify_after_sec)
      ? Math.max(1, Math.floor(o.fault_if_online_but_no_verify_after_sec))
      : null;

  return {
    ackTimeoutSec,
    verifyTimeoutSec,
    quickRetrySeconds,
    maxAttempts,
    ackRetryMinDelaySec,
    telemetryCycleSec,
    lateConfirmationWindowSec,
    retryBackoffMode,
    retryJitterPct,
    singleFlightEnabled,
    autoRefreshAfterSwitchEnabled,
    autoRefreshDelaySec,
    parentFinalizeFromChildRefresh,
    parentLateSuccessEnabled,
    retryIntervalSec,
    deliveryWindowSec,
    raiseCommunicationFaultEnabled,
    faultIfOnlineButNoAckAfterSec,
    faultIfOnlineButNoVerifyAfterSec
  };
};

/**
 * Picks SwitchSta from typical device JSON shapes (indicate ack, data/up update).
 * Order matches verify precedence: any embedded `reported.SwitchSta` in the ack/update body.
 */
export const extractSwitchStaFromPayload = (payload: unknown): number | null => {
  const tryReported = (node: Record<string, unknown> | null): number | null => {
    if (!node) {
      return null;
    }
    const reported = asObject(node.reported);
    if (reported && Object.prototype.hasOwnProperty.call(reported, "SwitchSta")) {
      return toFiniteSwitch(reported.SwitchSta);
    }
    return null;
  };

  const root = asObject(payload);
  if (!root) {
    return null;
  }

  const direct = toFiniteSwitch(root.SwitchSta);
  if (direct !== null) {
    return direct;
  }

  const paths: unknown[] = [
    root.reported,
    root.data,
    root.params,
    root.payload,
    root.result,
    root.response
  ];
  for (const p of paths) {
    const po = asObject(p);
    const fromNested = tryReported(po);
    if (fromNested !== null) {
      return fromNested;
    }
    if (po) {
      const inner = asObject(po.data) ?? asObject(po.body);
      const fromInner = tryReported(inner);
      if (fromInner !== null) {
        return fromInner;
      }
    }
  }

  return tryReported(root);
};

const METER_OR_ACK_EXTRA_KEYS = new Set([
  "U",
  "I",
  "P",
  "PF",
  "EPI",
  "Balance",
  "Ua",
  "Ia",
  "SwitchSta",
  "rssi",
  "channel",
  "mac_address",
  "mac"
]);

/** Meter signals that qualify standalone refresh verify from data/up or ACK (device doc). */
const STANDALONE_METER_SIGNAL_KEYS = new Set([
  "U",
  "I",
  "P",
  "PF",
  "EPI",
  "Balance",
  "rssi",
  "channel",
  "mac_address",
  "SwitchSta",
  "Ua",
  "Ia"
]);

const hasAnyMeterSignalKey = (o: Record<string, unknown>): boolean => {
  for (const k of STANDALONE_METER_SIGNAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      return true;
    }
  }
  return false;
};

const scanObjectTreeForMeterSignals = (node: Record<string, unknown>): boolean => {
  if (hasAnyMeterSignalKey(node)) {
    return true;
  }
  for (const v of Object.values(node)) {
    const nested = asObject(v);
    if (nested && hasAnyMeterSignalKey(nested)) {
      return true;
    }
    if (nested && scanObjectTreeForMeterSignals(nested)) {
      return true;
    }
  }
  return false;
};

/**
 * True when raw JSON (data/up payload, last_summary, or indicate ACK) contains at least one
 * standalone-verify meter field — root, `reported` (incl. reported[sn] / dynamic keys),
 * `data`/`params`/`result`/`response`/`payload`, nested values.
 */
export const hasSubstantiveMeterForStandaloneRefreshVerify = (payload: unknown): boolean => {
  const root = asObject(payload);
  if (!root) {
    return false;
  }
  if (hasAnyMeterSignalKey(root)) {
    return true;
  }
  const reported = asObject(root.reported);
  if (reported && scanObjectTreeForMeterSignals(reported)) {
    return true;
  }
  for (const key of ["data", "params", "result", "response", "payload"] as const) {
    const block = asObject(root[key]);
    if (!block) {
      continue;
    }
    if (scanObjectTreeForMeterSignals(block)) {
      return true;
    }
  }
  return false;
};

const MAX_EVIDENCE_DEPTH = 16;

/**
 * Dot path to the first object that carries a standalone meter field (for logs), e.g.
 * `inbound_update_payload.reported.24042809890002`.
 */
export const getStandaloneMeterEvidencePath = (
  payload: unknown,
  pathPrefix: string
): string | null => {
  const walk = (node: unknown, parts: string[], depth: number): string[] | null => {
    if (depth > MAX_EVIDENCE_DEPTH) {
      return null;
    }
    const o = asObject(node);
    if (!o) {
      return null;
    }
    if (hasAnyMeterSignalKey(o)) {
      return parts;
    }
    for (const [k, v] of Object.entries(o)) {
      const child = asObject(v);
      if (!child) {
        continue;
      }
      const hit = walk(child, [...parts, k], depth + 1);
      if (hit) {
        return hit;
      }
    }
    return null;
  };
  const segs = walk(payload, [], 0);
  if (!segs) {
    return null;
  }
  const tail = segs.join(".");
  return tail.length > 0 ? `${pathPrefix}.${tail}` : pathPrefix;
};

/**
 * True when indicate/dev refresh ACK carries meter/telemetry beyond a bare operate envelope
 * (e.g. nested `payload` with U/I/P or `reported`), so standalone refresh can verify without data/up.
 */
export const isSubstantiveRefreshAckPayload = (payload: unknown): boolean => {
  if (hasSubstantiveMeterForStandaloneRefreshVerify(payload)) {
    return true;
  }
  const root = asObject(payload);
  if (!root) {
    return false;
  }
  const nested = asObject(root.payload);
  if (nested) {
    for (const k of Object.keys(nested)) {
      if (METER_OR_ACK_EXTRA_KEYS.has(k)) {
        return true;
      }
    }
    const beyondEcho = Object.keys(nested).filter((k) => k !== "method" && k !== "addr");
    if (beyondEcho.length >= 1) {
      return true;
    }
  }
  for (const k of METER_OR_ACK_EXTRA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(root, k)) {
      return true;
    }
  }
  const reported = asObject(root.reported);
  return reported !== null && Object.keys(reported).length > 0;
};

/** Device doc: successful operate ACK has root `res` numeric 1. */
export const isOperateAckResAccepted = (payload: unknown): boolean => {
  const root = asObject(payload);
  if (!root) {
    return false;
  }
  const res = root.res;
  if (res === 1) {
    return true;
  }
  if (res === "1") {
    return true;
  }
  return false;
};

/**
 * When the device includes an `operate` block or nested `payload` in the ACK, optionally validate
 * against the command type. Minimal ACK shapes ({ method, sn, msgid, res: 1 }) pass through.
 */
export const correlateOperateAckWithCommand = (
  commandType: string,
  payload: unknown
): { ok: true } | { ok: false; reason: string } => {
  const root = asObject(payload);
  if (!root) {
    return { ok: true };
  }

  const op = asObject(root.operate);
  if (op && typeof op.code === "string") {
    const upper = op.code.trim().toUpperCase();
    if (commandType === "force_switch_0" || commandType === "force_switch_1") {
      if (upper !== "FORCE_SWITCH") {
        return { ok: false, reason: `operate_code_expected_FORCE_SWITCH_got_${op.code}` };
      }
      const expected = commandType === "force_switch_0" ? 0 : 1;
      if ("target" in op && op.target !== undefined && op.target !== null) {
        const t = toFiniteSwitch(op.target);
        if (t !== null && t !== expected) {
          return { ok: false, reason: `operate_target_expected_${expected}_got_${t}` };
        }
      }
      return { ok: true };
    }
    if (commandType === "refresh") {
      if (upper === "FORCE_SWITCH") {
        return { ok: false, reason: "operate_FORCE_SWITCH_on_refresh_command" };
      }
      return { ok: true };
    }
    return { ok: true };
  }

  const pl = asObject(root.payload);
  if (pl) {
    const pmRaw = pl.method;
    const pm = typeof pmRaw === "string" ? pmRaw.trim().toUpperCase() : "";
    if (pm === "FORCESWITCH") {
      if (commandType === "refresh") {
        return { ok: false, reason: "payload_FORCESWITCH_on_refresh_command" };
      }
      if (commandType === "force_switch_0" || commandType === "force_switch_1") {
        const expected = commandType === "force_switch_0" ? 0 : 1;
        if ("ForceSwitch" in pl) {
          const fs = toFiniteSwitch(pl.ForceSwitch);
          if (fs !== null && fs !== expected) {
            return { ok: false, reason: `payload_ForceSwitch_expected_${expected}_got_${fs}` };
          }
        }
        if ("do1" in pl) {
          const d = toFiniteSwitch(pl.do1);
          if (d !== null && d !== expected) {
            return { ok: false, reason: `payload_do1_expected_${expected}_got_${d}` };
          }
        }
      }
      return { ok: true };
    }
    if (pm === "REFRESH") {
      if (commandType !== "refresh") {
        return { ok: false, reason: "payload_REFRESH_on_non_refresh_command" };
      }
      return { ok: true };
    }
  }

  return { ok: true };
};

/**
 * Delay before the next publish attempt after an ACK timeout, using `quick_retry_seconds`
 * and current `attempt_count` (as stored on the row after claim publishes).
 */
export const nextQuickRetryDelayMs = (
  policy: ParsedCommandPolicy,
  attemptCountAfterPublish: number
): number => {
  const arr = policy.quickRetrySeconds;
  const idx = Math.min(Math.max(attemptCountAfterPublish - 1, 0), arr.length - 1);
  return arr[idx]! * 1000;
};

/** Uniform jitter in [base*(1-p), base*(1+p)] to reduce herd retries across many devices. */
export const applyRetryJitter = (baseMs: number, jitterPct: number): number => {
  const j = Math.min(100, Math.max(0, jitterPct)) / 100;
  if (j <= 0 || !Number.isFinite(baseMs)) {
    return Math.round(baseMs);
  }
  const lo = baseMs * (1 - j);
  const hi = baseMs * (1 + j);
  return Math.round(lo + Math.random() * (hi - lo));
};

/**
 * Bounded ACK retry delay: combines `quick_retry_seconds` schedule with minimum spacing,
 * optional exponential/linear extra backoff vs min delay, and jitter.
 */
export const computeAckRetryDelayMs = (
  policy: ParsedCommandPolicy,
  attemptCountAfterPublish: number
): number => {
  const quick = nextQuickRetryDelayMs(policy, attemptCountAfterPublish);
  const minFloor = Math.max(0, policy.ackRetryMinDelaySec) * 1000;
  let base = Math.max(quick, minFloor);

  if (policy.retryBackoffMode === "exponential") {
    const mult = Math.pow(2, Math.min(Math.max(attemptCountAfterPublish - 1, 0), 14));
    base = Math.max(base, minFloor * mult);
  } else if (policy.retryBackoffMode === "linear") {
    base = Math.max(base, minFloor * Math.max(attemptCountAfterPublish, 1));
  }
  // fixed: base stays max(quickRetry, minFloor)

  return applyRetryJitter(base, policy.retryJitterPct);
};

/**
 * Legacy helper: merges env/global min delay (seconds) into policy for one call.
 * Prefer `computeAckRetryDelayMs` with `ack_retry_min_delay_sec` on the policy snapshot.
 */
export const effectiveAckRetryDelayMs = (
  policy: ParsedCommandPolicy,
  attemptCountAfterPublish: number,
  minDelaySec: number
): number => {
  return computeAckRetryDelayMs(
    {
      ...policy,
      ackRetryMinDelaySec: Math.max(policy.ackRetryMinDelaySec, minDelaySec)
    },
    attemptCountAfterPublish
  );
};

export type ParentVerifyOutcome =
  | { status: "verified_success"; expectedSwitch: number; actualSwitch: number }
  | { status: "verified_mismatch"; expectedSwitch: number; actualSwitch: number };

export const evaluateParentSwitchVerification = (
  commandType: string,
  actualSwitch: number | null
): ParentVerifyOutcome | null => {
  if (commandType !== "force_switch_0" && commandType !== "force_switch_1") {
    return null;
  }
  if (actualSwitch === null || !Number.isFinite(actualSwitch)) {
    return null;
  }
  const expectedSwitch = commandType === "force_switch_0" ? 0 : 1;
  return actualSwitch === expectedSwitch
    ? { status: "verified_success", expectedSwitch, actualSwitch }
    : { status: "verified_mismatch", expectedSwitch, actualSwitch };
};
