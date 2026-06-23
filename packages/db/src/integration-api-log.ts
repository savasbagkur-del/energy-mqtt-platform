import type { Pool } from "pg";

export type IntegrationApiDirection = "auth" | "read" | "control";
export type IntegrationApiFamily = "easytech" | "v1";

export interface IntegrationApiLogInput {
  customerId?: string | null;
  panelUserId?: string | null;
  username?: string | null;
  apiFamily?: IntegrationApiFamily;
  direction: IntegrationApiDirection;
  endpoint: string;
  httpMethod: string;
  roomNo?: string | null;
  sn?: string | null;
  switchValue?: 0 | 1 | null;
  success: boolean;
  errorMsg?: string | null;
  durationMs?: number | null;
  clientIp?: string | null;
}

export interface IntegrationApiLogRow {
  id: string;
  customer_id: string | null;
  panel_user_id: string | null;
  username: string | null;
  api_family: string;
  direction: IntegrationApiDirection;
  endpoint: string;
  http_method: string;
  room_no: string | null;
  sn: string | null;
  switch_value: number | null;
  success: boolean;
  error_msg: string | null;
  duration_ms: number | null;
  client_ip: string | null;
  created_at: string;
}

const toRow = (r: Record<string, unknown>): IntegrationApiLogRow => ({
  id: String(r.id),
  customer_id: r.customer_id != null ? String(r.customer_id) : null,
  panel_user_id: r.panel_user_id != null ? String(r.panel_user_id) : null,
  username: (r.username as string) ?? null,
  api_family: String(r.api_family ?? "easytech"),
  direction: r.direction as IntegrationApiDirection,
  endpoint: String(r.endpoint),
  http_method: String(r.http_method),
  room_no: (r.room_no as string) ?? null,
  sn: (r.sn as string) ?? null,
  switch_value: r.switch_value != null ? Number(r.switch_value) : null,
  success: r.success === true,
  error_msg: (r.error_msg as string) ?? null,
  duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
  client_ip: (r.client_ip as string) ?? null,
  created_at: String(r.created_at)
});

/** Fire-and-forget safe: never throws to callers. */
export const insertIntegrationApiLog = async (
  pool: Pool,
  input: IntegrationApiLogInput
): Promise<void> => {
  try {
    await pool.query(
      `INSERT INTO integration_api_log (
         customer_id, panel_user_id, username, api_family, direction,
         endpoint, http_method, room_no, sn, switch_value,
         success, error_msg, duration_ms, client_ip
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        input.customerId ?? null,
        input.panelUserId ?? null,
        input.username ?? null,
        input.apiFamily ?? "easytech",
        input.direction,
        input.endpoint,
        input.httpMethod,
        input.roomNo ?? null,
        input.sn ?? null,
        input.switchValue ?? null,
        input.success,
        input.errorMsg ?? null,
        input.durationMs ?? null,
        input.clientIp ?? null
      ]
    );
  } catch {
    // audit must not break API responses
  }
};

export interface ListIntegrationApiLogsFilter {
  customerId: string;
  limit?: number;
  offset?: number;
}

export const listIntegrationApiLogs = async (
  pool: Pool,
  filter: ListIntegrationApiLogsFilter
): Promise<{ items: IntegrationApiLogRow[]; total: number }> => {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
  const [listRes, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM integration_api_log
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [filter.customerId, limit, offset]
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM integration_api_log WHERE customer_id = $1`,
      [filter.customerId]
    )
  ]);
  return {
    items: listRes.rows.map((r) => toRow(r as Record<string, unknown>)),
    total: Number(countRes.rows[0]?.n ?? "0")
  };
};

export interface IntegrationApiLogSummary {
  total_24h: number;
  read_24h: number;
  control_24h: number;
  auth_24h: number;
  last_at: string | null;
  last_success_at: string | null;
}

export const getIntegrationApiLogSummary = async (
  pool: Pool,
  customerId: string
): Promise<IntegrationApiLogSummary> => {
  const res = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS total_24h,
       COUNT(*) FILTER (WHERE direction = 'read' AND created_at >= NOW() - INTERVAL '24 hours') AS read_24h,
       COUNT(*) FILTER (WHERE direction = 'control' AND created_at >= NOW() - INTERVAL '24 hours') AS control_24h,
       COUNT(*) FILTER (WHERE direction = 'auth' AND created_at >= NOW() - INTERVAL '24 hours') AS auth_24h,
       MAX(created_at) AS last_at,
       MAX(created_at) FILTER (WHERE success) AS last_success_at
     FROM integration_api_log
     WHERE customer_id = $1`,
    [customerId]
  );
  const r = res.rows[0] ?? {};
  return {
    total_24h: Number(r.total_24h ?? 0),
    read_24h: Number(r.read_24h ?? 0),
    control_24h: Number(r.control_24h ?? 0),
    auth_24h: Number(r.auth_24h ?? 0),
    last_at: (r.last_at as string) ?? null,
    last_success_at: (r.last_success_at as string) ?? null
  };
};
