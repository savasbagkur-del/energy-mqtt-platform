import type { Pool } from "pg";
import type { DiagnosticRunRow } from "./types.js";

export const createDiagnosticRun = async (
  pool: Pool,
  input: {
    sn: string;
    productKey: string;
    intervalMs: number;
    durationSec: number;
    plannedCount: number;
  }
): Promise<DiagnosticRunRow> => {
  const existing = await pool.query<DiagnosticRunRow>(
    `SELECT * FROM diagnostic_runs
     WHERE sn = $1
       AND status IN ('scheduled', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.sn]
  );
  if (existing.rows[0]) {
    throw new Error("diagnostic_already_active_for_device");
  }

  const result = await pool.query<DiagnosticRunRow>(
    `INSERT INTO diagnostic_runs (
      sn, product_key, status, interval_ms, duration_sec, planned_count, started_at
    ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
    RETURNING *`,
    [input.sn, input.productKey, "scheduled", input.intervalMs, input.durationSec, input.plannedCount]
  );
  const created = result.rows[0];
  if (!created) {
    throw new Error("failed_to_create_diagnostic_run");
  }
  return created;
};

export const updateDiagnosticRunStats = async (
  pool: Pool,
  id: string,
  input: {
    status?: string;
    sentCountDelta?: number;
    ackCountDelta?: number;
    responseCountDelta?: number;
    summary?: unknown;
    finishedAt?: Date | null;
  }
): Promise<void> => {
  await pool.query(
    `UPDATE diagnostic_runs SET
      status = COALESCE($2, status),
      sent_count = sent_count + $3,
      ack_count = ack_count + $4,
      response_count = response_count + $5,
      summary = COALESCE($6::jsonb, summary),
      finished_at = COALESCE($7, finished_at)
    WHERE id = $1`,
    [
      id,
      input.status ?? null,
      input.sentCountDelta ?? 0,
      input.ackCountDelta ?? 0,
      input.responseCountDelta ?? 0,
      input.summary == null ? null : JSON.stringify(input.summary),
      input.finishedAt ?? null
    ]
  );
};

export const getDiagnosticRunById = async (
  pool: Pool,
  id: string
): Promise<DiagnosticRunRow | null> => {
  const result = await pool.query<DiagnosticRunRow>(
    `SELECT * FROM diagnostic_runs WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
};
