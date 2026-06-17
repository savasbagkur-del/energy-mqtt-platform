import type { Pool } from "pg";
import type { DeviceDesiredStateRow, ReconcileStatus } from "./types.js";

export const SWITCH_CAPABILITY = "switch";

/** Active (non-terminal) command statuses that count as a switch already in flight for a device. */
const ACTIVE_COMMAND_STATUSES = [
  "created",
  "scheduled",
  "published",
  "ack_received",
  "verify_pending"
] as const;

/**
 * Upsert the durable switch intent for a device. Implements supersede:
 *  - changed target  → cancel in-flight switch commands, reset attempt_count, status=pending, eval now.
 *  - same target, not reconciled → re-arm (eval now) so reconciler retries promptly.
 *  - same target, reconciled → keep reconciled but re-arm eval (idempotent, cheap re-check).
 */
export const upsertDesiredSwitch = async (
  pool: Pool,
  input: { sn: string; productKey: string | null; value: 0 | 1; setBy?: string | null }
): Promise<{ row: DeviceDesiredStateRow; superseded: boolean; cancelledCommandIds: string[] }> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingRes = await client.query<DeviceDesiredStateRow>(
      `SELECT * FROM device_desired_state
       WHERE sn = $1 AND capability = $2
       FOR UPDATE`,
      [input.sn, SWITCH_CAPABILITY]
    );
    const existing = existingRes.rows[0] ?? null;
    const desiredJson = JSON.stringify({ switch: input.value });

    let superseded = false;
    let cancelledCommandIds: string[] = [];

    if (existing) {
      const prev = (existing.desired_value as { switch?: number } | null)?.switch;
      const targetChanged = prev !== input.value;
      if (targetChanged) {
        const cancelled = await client.query<{ id: string }>(
          `UPDATE commands
           SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(),
               error_message = COALESCE(error_message, 'superseded by new desired switch')
           WHERE sn = $1
             AND command_type IN ('force_switch_0', 'force_switch_1')
             AND status = ANY($2::text[])
           RETURNING id`,
          [input.sn, ACTIVE_COMMAND_STATUSES as unknown as string[]]
        );
        cancelledCommandIds = cancelled.rows.map((r) => r.id);
        superseded = true;
      }

      const updated = await client.query<DeviceDesiredStateRow>(
        `UPDATE device_desired_state SET
           product_key = COALESCE($3, product_key),
           desired_value = $4::jsonb,
           desired_set_by = $5,
           desired_set_at = NOW(),
           reconcile_status = 'pending',
           attempt_count = CASE WHEN $6 THEN 0 ELSE attempt_count END,
           last_command_id = CASE WHEN $6 THEN NULL ELSE last_command_id END,
           unreachable_since = NULL,
           next_eval_at = NOW(),
           updated_at = NOW()
         WHERE id = $1 AND capability = $2
         RETURNING *`,
        [existing.id, SWITCH_CAPABILITY, input.productKey, desiredJson, input.setBy ?? null, superseded]
      );
      await client.query("COMMIT");
      const row = updated.rows[0];
      if (!row) {
        throw new Error("failed_to_update_desired_state");
      }
      return { row, superseded, cancelledCommandIds };
    }

    const inserted = await client.query<DeviceDesiredStateRow>(
      `INSERT INTO device_desired_state (
         sn, product_key, capability, desired_value, desired_set_by, reconcile_status, next_eval_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, 'pending', NOW())
       RETURNING *`,
      [input.sn, input.productKey, SWITCH_CAPABILITY, desiredJson, input.setBy ?? null]
    );
    await client.query("COMMIT");
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("failed_to_insert_desired_state");
    }
    return { row, superseded: false, cancelledCommandIds: [] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const cancelDesiredState = async (
  pool: Pool,
  sn: string,
  capability: string = SWITCH_CAPABILITY
): Promise<DeviceDesiredStateRow | null> => {
  const result = await pool.query<DeviceDesiredStateRow>(
    `UPDATE device_desired_state
     SET reconcile_status = 'cancelled', updated_at = NOW()
     WHERE sn = $1 AND capability = $2
     RETURNING *`,
    [sn, capability]
  );
  return result.rows[0] ?? null;
};

export const getDesiredState = async (
  pool: Pool,
  sn: string,
  capability: string = SWITCH_CAPABILITY
): Promise<DeviceDesiredStateRow | null> => {
  const result = await pool.query<DeviceDesiredStateRow>(
    `SELECT * FROM device_desired_state WHERE sn = $1 AND capability = $2`,
    [sn, capability]
  );
  return result.rows[0] ?? null;
};

/** Rows due for a reconciler pass (non-terminal status + eval time reached). */
export const listDueDesiredStates = async (
  pool: Pool,
  limit = 200
): Promise<DeviceDesiredStateRow[]> => {
  const result = await pool.query<DeviceDesiredStateRow>(
    `SELECT * FROM device_desired_state
     WHERE reconcile_status IN ('pending', 'in_flight', 'unreachable')
       AND next_eval_at <= NOW()
     ORDER BY next_eval_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(1000, limit))]
  );
  return result.rows;
};

/**
 * Multi-instance safe claim: leases due rows by pushing next_eval_at forward (lease window) under
 * FOR UPDATE SKIP LOCKED, so concurrent worker instances never process the same desired row in the
 * same pass. The reconciler then sets the real next_eval_at per outcome.
 */
export const claimDueDesiredStates = async (
  pool: Pool,
  limit = 200,
  leaseSeconds = 15
): Promise<DeviceDesiredStateRow[]> => {
  const safeLimit = Math.max(1, Math.min(1000, limit));
  const safeLease = Math.max(1, Math.floor(leaseSeconds));
  const result = await pool.query<DeviceDesiredStateRow>(
    `WITH due AS (
       SELECT id FROM device_desired_state
       WHERE reconcile_status IN ('pending', 'in_flight', 'unreachable')
         AND next_eval_at <= NOW()
       ORDER BY next_eval_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE device_desired_state d
     SET next_eval_at = NOW() + ($2 * interval '1 second'), updated_at = NOW()
     FROM due
     WHERE d.id = due.id
     RETURNING d.*`,
    [safeLimit, safeLease]
  );
  return result.rows;
};

export const markDesiredReconciled = async (
  pool: Pool,
  id: string,
  reportedValue: unknown
): Promise<void> => {
  await pool.query(
    `UPDATE device_desired_state SET
       reconcile_status = 'reconciled',
       reported_value = $2::jsonb,
       reconciled_at = NOW(),
       unreachable_since = NULL,
       updated_at = NOW()
     WHERE id = $1`,
    [id, reportedValue == null ? null : JSON.stringify(reportedValue)]
  );
};

export const markDesiredUnreachable = async (
  pool: Pool,
  id: string,
  nextEvalAt: Date
): Promise<void> => {
  await pool.query(
    `UPDATE device_desired_state SET
       reconcile_status = 'unreachable',
       unreachable_since = COALESCE(unreachable_since, NOW()),
       next_eval_at = $2,
       updated_at = NOW()
     WHERE id = $1`,
    [id, nextEvalAt]
  );
};

export const markDesiredInFlight = async (
  pool: Pool,
  id: string,
  options: { commandId?: string | null; incrementAttempt: boolean; nextEvalAt: Date }
): Promise<void> => {
  await pool.query(
    `UPDATE device_desired_state SET
       reconcile_status = 'in_flight',
       last_command_id = COALESCE($2, last_command_id),
       attempt_count = attempt_count + CASE WHEN $3 THEN 1 ELSE 0 END,
       last_attempt_at = CASE WHEN $3 THEN NOW() ELSE last_attempt_at END,
       unreachable_since = NULL,
       next_eval_at = $4,
       updated_at = NOW()
     WHERE id = $1`,
    [id, options.commandId ?? null, options.incrementAttempt, options.nextEvalAt]
  );
};

export const setDesiredNextEval = async (
  pool: Pool,
  id: string,
  nextEvalAt: Date
): Promise<void> => {
  await pool.query(
    `UPDATE device_desired_state SET next_eval_at = $2, updated_at = NOW() WHERE id = $1`,
    [id, nextEvalAt]
  );
};

/** Re-arm pending/unreachable rows for a device so the next reconciler pass acts immediately. */
export const triggerReconcileForSn = async (pool: Pool, sn: string): Promise<void> => {
  await pool.query(
    `UPDATE device_desired_state SET next_eval_at = NOW(), updated_at = NOW()
     WHERE sn = $1 AND reconcile_status IN ('pending', 'in_flight', 'unreachable')`,
    [sn]
  );
};

export const setDesiredStatus = async (
  pool: Pool,
  id: string,
  status: ReconcileStatus
): Promise<void> => {
  await pool.query(
    `UPDATE device_desired_state SET reconcile_status = $2, updated_at = NOW() WHERE id = $1`,
    [id, status]
  );
};
