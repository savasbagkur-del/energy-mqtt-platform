import type { Pool } from "pg";

/**
 * Per-SN cache for `devices.telemetry_mode`.
 *
 * The telemetry write path runs for every inbound `data/up` message (one per device per
 * reporting interval). Looking up the telemetry mode with a `SELECT ... WHERE sn = $1` on
 * every one of those messages is pure overhead: the mode only ever changes when an operator
 * (re)registers a device. This cache turns that hot per-message read into an in-process map
 * hit, which matters a lot at fleet scale (tens of thousands of meters).
 *
 * Correctness / propagation:
 *  - Within the same process, the registry write path calls {@link invalidateTelemetryModeCache}
 *    so a mode change is reflected immediately.
 *  - API and worker are separate processes, so a mode change made in the API does not invalidate
 *    the worker's copy synchronously. The TTL bounds that staleness: the worker picks up the new
 *    mode within at most TTL. Since mode only flips on a rare admin re-registration, the worst case
 *    is one or two telemetry samples stored under the previous profile before it self-heals.
 *  - TTL is intentionally longer than the device reporting interval (~5 dk) so the periodic
 *    `data/up update` actually hits the cache instead of expiring between every report.
 */
export type CachedTelemetryMode = "consumption" | "analysis" | null;

interface CacheEntry {
  mode: CachedTelemetryMode;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 dk: cihaz raporlama aralığından (~5 dk) uzun, böylece periyodik raporlar cache'e isabet eder
const cache = new Map<string, CacheEntry>();

const normalizeMode = (raw: string | null | undefined): CachedTelemetryMode =>
  raw === "consumption" || raw === "analysis" ? raw : null;

/**
 * Returns the telemetry mode for a device, hitting the DB only on a cache miss / expiry.
 */
export const getCachedTelemetryMode = async (
  pool: Pool,
  sn: string
): Promise<CachedTelemetryMode> => {
  const now = Date.now();
  const hit = cache.get(sn);
  if (hit && hit.expiresAt > now) {
    return hit.mode;
  }
  const result = await pool.query<{ telemetry_mode: string | null }>(
    `SELECT telemetry_mode FROM devices WHERE sn = $1`,
    [sn]
  );
  const mode = normalizeMode(result.rows[0]?.telemetry_mode);
  cache.set(sn, { mode, expiresAt: now + TTL_MS });
  return mode;
};

/** Drop a single device from the cache (call after its telemetry_mode may have changed). */
export const invalidateTelemetryModeCache = (sn: string): void => {
  cache.delete(sn);
};

/** Clear the entire cache (mainly for tests). */
export const clearTelemetryModeCache = (): void => {
  cache.clear();
};
