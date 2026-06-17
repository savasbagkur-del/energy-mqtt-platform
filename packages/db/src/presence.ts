import type { Pool } from "pg";
import type { DevicePresenceRow, PresenceStatus } from "./types.js";

export const upsertPresence = async (
  pool: Pool,
  input: { sn: string; status: PresenceStatus; source: string; at?: Date }
): Promise<void> => {
  const at = input.at ?? new Date();
  await pool.query(
    `INSERT INTO device_presence (
       sn, status, connected_at, disconnected_at, last_event_at, source, updated_at
     ) VALUES (
       $1, $2,
       CASE WHEN $2 = 'online' THEN $3::timestamptz ELSE NULL END,
       CASE WHEN $2 = 'offline' THEN $3::timestamptz ELSE NULL END,
       $3::timestamptz, $4, NOW()
     )
     ON CONFLICT (sn) DO UPDATE SET
       status = EXCLUDED.status,
       connected_at = CASE WHEN EXCLUDED.status = 'online' THEN EXCLUDED.last_event_at ELSE device_presence.connected_at END,
       disconnected_at = CASE WHEN EXCLUDED.status = 'offline' THEN EXCLUDED.last_event_at ELSE device_presence.disconnected_at END,
       last_event_at = GREATEST(device_presence.last_event_at, EXCLUDED.last_event_at),
       source = EXCLUDED.source,
       updated_at = NOW()`,
    [input.sn, input.status, at, input.source]
  );
};

export const getPresence = async (
  pool: Pool,
  sn: string
): Promise<DevicePresenceRow | null> => {
  const result = await pool.query<DevicePresenceRow>(
    `SELECT * FROM device_presence WHERE sn = $1`,
    [sn]
  );
  return result.rows[0] ?? null;
};

/**
 * Two-layer reachability decision (gateway-aware, simulator-friendly):
 *  (a) explicit EMQX presence event says 'online' within onlineTtl, OR
 *  (b) telemetry freshness: devices.last_seen_at within onlineTtl.
 * Explicit 'offline' within onlineTtl overrides stale telemetry.
 */
export const resolveDeviceOnline = async (
  pool: Pool,
  sn: string,
  onlineTtlSec: number
): Promise<boolean> => {
  const ttl = Math.max(1, Math.floor(onlineTtlSec));
  const result = await pool.query<{ online: boolean }>(
    `SELECT (
       -- explicit recent online event
       EXISTS (
         SELECT 1 FROM device_presence p
         WHERE p.sn = $1 AND p.status = 'online'
           AND p.last_event_at > NOW() - ($2 * interval '1 second')
       )
       OR (
         -- telemetry freshness, unless a recent explicit offline event contradicts it
         EXISTS (
           SELECT 1 FROM devices d
           WHERE d.sn = $1 AND d.last_seen_at > NOW() - ($2 * interval '1 second')
         )
         AND NOT EXISTS (
           SELECT 1 FROM device_presence p
           WHERE p.sn = $1 AND p.status = 'offline'
             AND p.last_event_at > NOW() - ($2 * interval '1 second')
         )
       )
     ) AS online`,
    [sn, ttl]
  );
  return result.rows[0]?.online ?? false;
};
