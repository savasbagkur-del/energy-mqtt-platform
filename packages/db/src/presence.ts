import type { Pool } from "pg";
import type { DevicePresenceRow, PresenceStatus } from "./types.js";

export const upsertPresence = async (
  pool: Pool,
  input: { sn: string; status: PresenceStatus; source: string; at?: Date }
): Promise<void> => {
  const at = input.at ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the current row so the change-detection + log stays consistent under concurrency.
    const prev = await client.query<{ status: string }>(
      `SELECT status FROM device_presence WHERE sn = $1 FOR UPDATE`,
      [input.sn]
    );
    const prevStatus = prev.rows[0]?.status ?? null;
    await client.query(
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
    // Log only real transitions (first-ever sighting counts as a transition) so the timeline
    // captures when the device flipped online/offline without bloating on every heartbeat.
    if (prevStatus !== input.status) {
      await client.query(
        `INSERT INTO device_presence_events (sn, status, source, event_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [input.sn, input.status, input.source, at]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export interface PresenceEvent {
  status: PresenceStatus;
  source: string | null;
  eventAt: string;
}

export interface PresenceHistory {
  /** Status in effect at the start of the window (last event before it), or null if unknown. */
  priorStatus: PresenceStatus | null;
  /** Window start (ISO). */
  since: string;
  /** Server "now" (ISO) — the timeline's right edge. */
  now: string;
  events: PresenceEvent[];
}

/** Presence transitions for a device within the last `hours`, plus the state entering the window. */
export const getPresenceHistory = async (
  pool: Pool,
  sn: string,
  hours: number
): Promise<PresenceHistory> => {
  const h = Math.min(Math.max(Math.floor(hours) || 24, 1), 24 * 90);
  const prior = await pool.query<{ status: PresenceStatus }>(
    `SELECT status FROM device_presence_events
     WHERE sn = $1 AND event_at <= NOW() - ($2 * interval '1 hour')
     ORDER BY event_at DESC LIMIT 1`,
    [sn, h]
  );
  const rows = await pool.query<{ status: PresenceStatus; source: string | null; event_at: string }>(
    `SELECT status, source, event_at FROM device_presence_events
     WHERE sn = $1 AND event_at > NOW() - ($2 * interval '1 hour')
     ORDER BY event_at ASC`,
    [sn, h]
  );
  const meta = await pool.query<{ since: string; now: string }>(
    `SELECT (NOW() - ($1 * interval '1 hour'))::text AS since, NOW()::text AS now`,
    [h]
  );
  return {
    priorStatus: prior.rows[0]?.status ?? null,
    since: meta.rows[0]!.since,
    now: meta.rows[0]!.now,
    events: rows.rows.map((r) => ({ status: r.status, source: r.source, eventAt: r.event_at }))
  };
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
