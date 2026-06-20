import type { Pool } from "pg";
import type { AlarmSeverity, DeviceAlarmRow } from "./types.js";

export const ALARM_COMMAND_CONFIRMATION_TIMEOUT = "COMMAND_CONFIRMATION_TIMEOUT";

export interface RaiseAlarmInput {
  sn: string;
  alarmType: string;
  severity?: AlarmSeverity;
  message?: string | null;
  commandId?: string | null;
  desiredStateId?: string | null;
  fields?: Record<string, unknown>;
}

/**
 * Idempotently raise an alarm: at most one OPEN alarm per (sn, alarm_type). If one is already
 * open, refresh its message/fields/severity instead of creating a duplicate (matches the partial
 * unique index uq_device_alarms_open_per_type).
 */
export const raiseAlarm = async (pool: Pool, input: RaiseAlarmInput): Promise<DeviceAlarmRow> => {
  const result = await pool.query<DeviceAlarmRow>(
    `INSERT INTO device_alarms (sn, command_id, desired_state_id, alarm_type, severity, message, fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (sn, alarm_type) WHERE status = 'open'
     DO UPDATE SET
       command_id = EXCLUDED.command_id,
       desired_state_id = EXCLUDED.desired_state_id,
       severity = EXCLUDED.severity,
       message = EXCLUDED.message,
       fields = EXCLUDED.fields,
       updated_at = NOW()
     RETURNING *`,
    [
      input.sn,
      input.commandId ?? null,
      input.desiredStateId ?? null,
      input.alarmType,
      input.severity ?? "warning",
      input.message ?? null,
      JSON.stringify(input.fields ?? {})
    ]
  );
  return result.rows[0]!;
};

/** Clear all open alarms of a type for a device (e.g. once the command finally confirms). */
export const clearAlarms = async (pool: Pool, sn: string, alarmType: string): Promise<number> => {
  const result = await pool.query(
    `UPDATE device_alarms SET status = 'cleared', cleared_at = NOW(), updated_at = NOW()
     WHERE sn = $1 AND alarm_type = $2 AND status = 'open'`,
    [sn, alarmType]
  );
  return result.rowCount ?? 0;
};

export const acknowledgeAlarm = async (
  pool: Pool,
  id: string,
  acknowledgedBy: string | null
): Promise<DeviceAlarmRow | null> => {
  const result = await pool.query<DeviceAlarmRow>(
    `UPDATE device_alarms SET status = 'acknowledged', acknowledged_at = NOW(),
       acknowledged_by = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [id, acknowledgedBy]
  );
  return result.rows[0] ?? null;
};

export const listOpenAlarmsForSn = async (pool: Pool, sn: string): Promise<DeviceAlarmRow[]> => {
  const result = await pool.query<DeviceAlarmRow>(
    `SELECT * FROM device_alarms WHERE sn = $1 AND status = 'open' ORDER BY raised_at DESC`,
    [sn]
  );
  return result.rows;
};

export const listRecentAlarms = async (pool: Pool, limit = 100): Promise<DeviceAlarmRow[]> => {
  const result = await pool.query<DeviceAlarmRow>(
    `SELECT * FROM device_alarms ORDER BY raised_at DESC LIMIT $1`,
    [Math.max(1, Math.min(500, limit))]
  );
  return result.rows;
};
