import type { Pool } from "pg";
import type { DeviceSummaryView, LatestStateRow } from "./types.js";

export interface UpsertLatestStateInput {
  sn: string;
  productKey: string | null;
  lastMethod: string | null;
  lastMsgid: string | null;
  lastTimestamp: Date;
  lastTopic: string;
  lastPayload: unknown;
  lastSummary: unknown;
}

/**
 * Reported switch position from the typed telemetry-foundation table (device_latest_state),
 * populated from data/up `reported[sn].SwitchSta`. Authoritative source for reconcile success,
 * independent of latest_state JSON freshness ordering.
 */
export const getReportedSwitchState = async (
  pool: Pool,
  sn: string
): Promise<number | null> => {
  const result = await pool.query<{ switch_state: number | null }>(
    `SELECT switch_state FROM device_latest_state WHERE sn = $1`,
    [sn]
  );
  const value = result.rows[0]?.switch_state ?? null;
  return value === 0 || value === 1 ? value : null;
};

/**
 * Insert or update latest_state only when the new message time is strictly newer than stored
 * (or no row / null last_timestamp). Uses INSERT ... ON CONFLICT DO UPDATE ... WHERE.
 */
export const upsertLatestStateIfNewer = async (
  pool: Pool,
  input: UpsertLatestStateInput
): Promise<void> => {
  await pool.query(
    `INSERT INTO latest_state (
      sn,
      product_key,
      last_method,
      last_msgid,
      last_timestamp,
      last_topic,
      last_payload,
      last_summary,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, NOW())
    ON CONFLICT (sn) DO UPDATE SET
      product_key = EXCLUDED.product_key,
      last_method = EXCLUDED.last_method,
      last_msgid = EXCLUDED.last_msgid,
      last_timestamp = EXCLUDED.last_timestamp,
      last_topic = EXCLUDED.last_topic,
      last_payload = EXCLUDED.last_payload,
      last_summary = EXCLUDED.last_summary,
      updated_at = NOW()
    WHERE latest_state.last_timestamp IS NULL
       OR EXCLUDED.last_timestamp > latest_state.last_timestamp`,
    [
      input.sn,
      input.productKey,
      input.lastMethod,
      input.lastMsgid,
      input.lastTimestamp,
      input.lastTopic,
      JSON.stringify(input.lastPayload),
      input.lastSummary === null || input.lastSummary === undefined
        ? null
        : JSON.stringify(input.lastSummary)
    ]
  );
};

export const getLatestStateBySn = async (
  pool: Pool,
  sn: string
): Promise<LatestStateRow | null> => {
  const result = await pool.query<LatestStateRow>(
    `SELECT
      sn,
      product_key,
      last_method,
      last_msgid,
      last_timestamp,
      last_topic,
      last_payload,
      last_summary,
      updated_at
    FROM latest_state
    WHERE sn = $1`,
    [sn]
  );
  return result.rows[0] ?? null;
};

export const getDeviceSummaryBySn = async (
  pool: Pool,
  sn: string
): Promise<DeviceSummaryView | null> => {
  const result = await pool.query<DeviceSummaryView>(
    `SELECT
      d.sn,
      d.product_key,
      ls.last_method,
      ls.last_msgid,
      ls.last_timestamp,
      ls.last_topic,
      ls.last_summary AS summary
    FROM devices d
    LEFT JOIN latest_state ls ON ls.sn = d.sn
    WHERE d.sn = $1`,
    [sn]
  );
  return result.rows[0] ?? null;
};
