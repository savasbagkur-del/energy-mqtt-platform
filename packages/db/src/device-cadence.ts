import type { Pool } from "pg";
import type { CommandPolicyProfileRow } from "./types.js";

/**
 * Faz C — per-device adaptive timing.
 *
 * Learns each device's reconnect cadence from successive `login` (reconnect) events and merges the
 * learned interval into the command policy timing (ack/retry/delivery-window/TTL) and reconciler
 * backoff. Sleepy / cellular meters (e.g. the Acrel family that reconnects ~every 90s with a brief
 * online window) then get patient timing tuned to THEIR rhythm instead of hand-tuned globals:
 *  - command TTL no longer expires before the device's next wake,
 *  - retries land near the wake window instead of firing blindly,
 *  - reconciler backoff matches the cadence so it neither hammers nor sleeps too long.
 */

export interface DeviceCadenceRow {
  sn: string;
  product_key: string | null;
  ewma_reconnect_sec: number | null;
  last_gap_sec: number | null;
  min_gap_sec: number | null;
  max_gap_sec: number | null;
  sample_count: number;
  last_login_at: string | Date | null;
  updated_at: string | Date;
}

/** Gaps outside this band are treated as noise (very short bursts / multi-cycle outages). */
const MIN_SANE_GAP_SEC = 5;
const MAX_SANE_GAP_SEC = 1800;
const EWMA_ALPHA = 0.3;
const MAX_GAP_DECAY = 0.95;

/** Minimum healthy samples before learned cadence is allowed to override configured timing. */
export const CADENCE_MIN_SAMPLES = 3;

/**
 * Record a reconnect observation (call on each `login` event). Computes the gap from the previous
 * login and folds it into the EWMA. Uses a row lock so concurrent workers can't corrupt the stats.
 */
export const recordReconnectObservation = async (
  pool: Pool,
  input: { sn: string; productKey?: string | null; observedAt: Date }
): Promise<void> => {
  const { sn, productKey, observedAt } = input;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<DeviceCadenceRow>(
      `SELECT * FROM device_cadence_stats WHERE sn = $1 FOR UPDATE`,
      [sn]
    );
    const prev = existing.rows[0];

    if (!prev) {
      await client.query(
        `INSERT INTO device_cadence_stats (sn, product_key, last_login_at, sample_count)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (sn) DO UPDATE SET last_login_at = EXCLUDED.last_login_at, updated_at = NOW()`,
        [sn, productKey ?? null, observedAt]
      );
      await client.query("COMMIT");
      return;
    }

    let gap: number | null = null;
    if (prev.last_login_at) {
      const g = (observedAt.getTime() - new Date(prev.last_login_at).getTime()) / 1000;
      if (g >= MIN_SANE_GAP_SEC && g <= MAX_SANE_GAP_SEC) {
        gap = g;
      }
    }

    const ewma =
      gap === null
        ? prev.ewma_reconnect_sec
        : prev.ewma_reconnect_sec === null
          ? gap
          : EWMA_ALPHA * gap + (1 - EWMA_ALPHA) * prev.ewma_reconnect_sec;
    const minGap =
      gap === null
        ? prev.min_gap_sec
        : prev.min_gap_sec === null
          ? gap
          : Math.min(prev.min_gap_sec, gap);
    const maxGap =
      gap === null
        ? prev.max_gap_sec
        : prev.max_gap_sec === null
          ? gap
          : Math.max(prev.max_gap_sec * MAX_GAP_DECAY, gap);
    const sampleCount = prev.sample_count + (gap === null ? 0 : 1);

    await client.query(
      `UPDATE device_cadence_stats SET
         product_key = COALESCE($2, product_key),
         last_login_at = $3,
         ewma_reconnect_sec = $4,
         last_gap_sec = COALESCE($5, last_gap_sec),
         min_gap_sec = $6,
         max_gap_sec = $7,
         sample_count = $8,
         updated_at = NOW()
       WHERE sn = $1`,
      [sn, productKey ?? null, observedAt, ewma, gap, minGap, maxGap, sampleCount]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getDeviceCadence = async (
  pool: Pool,
  sn: string
): Promise<DeviceCadenceRow | null> => {
  const result = await pool.query<DeviceCadenceRow>(
    `SELECT * FROM device_cadence_stats WHERE sn = $1`,
    [sn]
  );
  return result.rows[0] ?? null;
};

const clamp = (value: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, value));

/**
 * Presence-gating window heuristic. The periodic publish loop must NOT publish to a device that is
 * mid-sleep (its QoS1 message would be dropped — these meters keep a clean session). The window
 * approximates the device's brief ONLINE burst, which is short and roughly cycle-independent, so we
 * scale mildly with the cycle but hard-clamp to [floor, cap]. The cap is the key safety: it prevents
 * the "window > online frequency" mistake (e.g. a 120s window for an 89s-cycle device made every
 * device look permanently online and defeated gating). Wake-flush remains the primary delivery path;
 * this gate is the backstop for commands created mid-burst.
 */
export const ADAPTIVE_GATING_FRACTION = 0.3;
export const ADAPTIVE_GATING_FLOOR_SEC = 10;
export const ADAPTIVE_GATING_CAP_SEC = 30;

/** Per-device gating window in seconds, or null when cadence isn't learned yet. */
export const deriveGatingWindowSec = (cadence: DeviceCadenceRow | null): number | null => {
  const cycle = cadence?.ewma_reconnect_sec ?? null;
  if (
    cadence === null ||
    cycle === null ||
    !Number.isFinite(cycle) ||
    cadence.sample_count < CADENCE_MIN_SAMPLES ||
    cycle < MIN_SANE_GAP_SEC ||
    cycle > MAX_SANE_GAP_SEC
  ) {
    return null;
  }
  return clamp(
    Math.round(cycle * ADAPTIVE_GATING_FRACTION),
    ADAPTIVE_GATING_FLOOR_SEC,
    ADAPTIVE_GATING_CAP_SEC
  );
};

export interface AdaptiveTimingDerivation {
  cycleSec: number;
  ackTimeoutSec: number;
  retryIntervalSec: number;
  deliveryWindowSec: number;
  commandTtlSec: number;
  telemetryCycleSec: number;
  reconcileMinBackoffSec: number;
  reconcileMaxBackoffSec: number;
  gatingWindowSec: number;
}

/**
 * Derive adaptive timing from the learned cycle. Returns null when there isn't enough signal yet
 * (caller should keep configured timing). Adaptive values only ever WIDEN patience relative to the
 * configured profile for delivery-window/TTL (clamped with the profile value as the lower bound),
 * so this can never make a well-tuned device less reliable.
 */
export const deriveAdaptiveTiming = (
  profile: CommandPolicyProfileRow,
  cadence: DeviceCadenceRow | null
): AdaptiveTimingDerivation | null => {
  const cycle = cadence?.ewma_reconnect_sec ?? null;
  if (
    cadence === null ||
    cycle === null ||
    !Number.isFinite(cycle) ||
    cadence.sample_count < CADENCE_MIN_SAMPLES ||
    cycle < MIN_SANE_GAP_SEC ||
    cycle > MAX_SANE_GAP_SEC
  ) {
    return null;
  }
  const c = Math.round(cycle);
  const reconcileMin = clamp(c, 15, 900);
  return {
    cycleSec: c,
    // Detect "no ack this wake" within the wake window, then retry ~one cycle later so the retry
    // lands on the next wake (ack_timeout + retry_interval ≈ one cycle).
    ackTimeoutSec: clamp(Math.round(c * 0.4), 8, 90),
    retryIntervalSec: clamp(Math.round(c * 0.6), 15, 600),
    deliveryWindowSec: clamp(c * 8, profile.delivery_window_sec ?? 720, 7200),
    commandTtlSec: clamp(c * 10, profile.command_ttl_sec ?? 300, 14400),
    telemetryCycleSec: clamp(c, 60, 3600),
    reconcileMinBackoffSec: reconcileMin,
    reconcileMaxBackoffSec: clamp(c * 4, reconcileMin, 3600),
    gatingWindowSec: clamp(
      Math.round(c * ADAPTIVE_GATING_FRACTION),
      ADAPTIVE_GATING_FLOOR_SEC,
      ADAPTIVE_GATING_CAP_SEC
    )
  };
};

/**
 * Return a profile clone with cadence-adapted timing fields, or the original profile unchanged when
 * there isn't enough learned signal.
 */
export const applyCadenceToPolicy = (
  profile: CommandPolicyProfileRow,
  cadence: DeviceCadenceRow | null
): CommandPolicyProfileRow => {
  const t = deriveAdaptiveTiming(profile, cadence);
  if (!t) {
    return profile;
  }
  return {
    ...profile,
    ack_timeout_sec: t.ackTimeoutSec,
    retry_interval_sec: t.retryIntervalSec,
    delivery_window_sec: t.deliveryWindowSec,
    command_ttl_sec: t.commandTtlSec,
    telemetry_cycle_sec: t.telemetryCycleSec,
    reconcile_min_backoff_sec: t.reconcileMinBackoffSec,
    reconcile_max_backoff_sec: t.reconcileMaxBackoffSec
  };
};
