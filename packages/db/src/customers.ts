import type { Pool, PoolClient } from "pg";
import type { PanelUserPublic } from "./panel-users.js";
import { registerDevice } from "./device-registry.js";

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface CustomerOverviewRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  panel_enabled: boolean;
  integration_mode: "panel" | "api";
  panel_username: string | null;
  device_count: number;
  online_count: number;
  active_key_count: number;
  last_api_used_at: string | null;
  created_at: string;
  /** Earliest commissioned_at among this customer's meters (first activation). */
  activated_at: string | null;
  /** Meters assigned but never communicated (awaiting field connection). */
  pending_meter_count: number;
  /** Pending meters with an unassigned registry SN match available to link. */
  linkable_quarantine_count: number;
}

/**
 * Customer list enriched with device counts and API-key/usage info so the UI can derive each
 * customer's connection type (panel / api / both) in a single grouped query.
 */
export const listCustomersOverview = async (
  pool: Pool,
  onlineWindowSec = 300
): Promise<CustomerOverviewRow[]> => {
  const win = Math.max(30, Math.min(86400, Math.floor(onlineWindowSec)));
  const res = await pool.query(
    `SELECT
       c.id, c.name, c.phone, c.email, c.notes, c.panel_enabled, c.integration_mode, c.created_at,
       MAX(pu.username) AS panel_username,
       COUNT(DISTINCT d.sn) AS device_count,
       COUNT(DISTINCT d.sn) FILTER (
         WHERE ls.last_seen_at >= NOW() - INTERVAL '${win} seconds'
       ) AS online_count,
       COUNT(DISTINCT k.id) FILTER (WHERE k.is_active) AS active_key_count,
       MAX(k.last_used_at) AS last_api_used_at,
       MIN(d.commissioned_at) FILTER (WHERE d.commissioned_at IS NOT NULL) AS activated_at,
       COUNT(DISTINCT d.sn) FILTER (WHERE d.last_seen_at IS NULL) AS pending_meter_count,
       COUNT(DISTINCT d.sn) FILTER (
         WHERE d.last_seen_at IS NULL
           AND d.registry_status <> 'quarantined'
           AND EXISTS (
             SELECT 1 FROM devices q
             WHERE q.customer_id IS NULL AND q.sn = d.sn
           )
       ) AS linkable_quarantine_count
     FROM customers c
     LEFT JOIN devices d ON d.customer_id = c.id
     LEFT JOIN device_latest_state ls ON ls.sn = d.sn
     LEFT JOIN customer_api_keys k ON k.customer_id = c.id
     LEFT JOIN panel_users pu ON pu.customer_id = c.id AND pu.is_active = TRUE
     GROUP BY c.id
     ORDER BY c.name ASC`
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    panel_enabled: r.panel_enabled === true,
    integration_mode: r.integration_mode === "api" ? "api" : "panel",
    panel_username: (r.panel_username as string | null) ?? null,
    device_count: int(r.device_count),
    online_count: int(r.online_count),
    active_key_count: int(r.active_key_count),
    last_api_used_at: (r.last_api_used_at as string | null) ?? null,
    created_at: String(r.created_at),
    activated_at: (r.activated_at as string | null) ?? null,
    pending_meter_count: int(r.pending_meter_count),
    linkable_quarantine_count: int(r.linkable_quarantine_count)
  }));
};

/** Single customer with the same enrichment as listCustomersOverview. */
export const getCustomerDetailById = async (
  pool: Pool,
  id: string,
  onlineWindowSec = 300
): Promise<CustomerOverviewRow | null> => {
  const win = Math.max(30, Math.min(86400, Math.floor(onlineWindowSec)));
  const res = await pool.query(
    `SELECT
       c.id, c.name, c.phone, c.email, c.notes, c.panel_enabled, c.integration_mode, c.created_at,
       MAX(pu.username) AS panel_username,
       COUNT(DISTINCT d.sn) AS device_count,
       COUNT(DISTINCT d.sn) FILTER (
         WHERE ls.last_seen_at >= NOW() - INTERVAL '${win} seconds'
       ) AS online_count,
       COUNT(DISTINCT k.id) FILTER (WHERE k.is_active) AS active_key_count,
       MAX(k.last_used_at) AS last_api_used_at,
       MIN(d.commissioned_at) FILTER (WHERE d.commissioned_at IS NOT NULL) AS activated_at,
       COUNT(DISTINCT d.sn) FILTER (WHERE d.last_seen_at IS NULL) AS pending_meter_count,
       COUNT(DISTINCT d.sn) FILTER (
         WHERE d.last_seen_at IS NULL
           AND d.registry_status <> 'quarantined'
           AND EXISTS (
             SELECT 1 FROM devices q
             WHERE q.customer_id IS NULL AND q.sn = d.sn
           )
       ) AS linkable_quarantine_count
     FROM customers c
     LEFT JOIN devices d ON d.customer_id = c.id
     LEFT JOIN device_latest_state ls ON ls.sn = d.sn
     LEFT JOIN customer_api_keys k ON k.customer_id = c.id
     LEFT JOIN panel_users pu ON pu.customer_id = c.id AND pu.is_active = TRUE
     WHERE c.id = $1
     GROUP BY c.id`,
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    panel_enabled: r.panel_enabled === true,
    integration_mode: r.integration_mode === "api" ? "api" : "panel",
    panel_username: (r.panel_username as string | null) ?? null,
    device_count: int(r.device_count),
    online_count: int(r.online_count),
    active_key_count: int(r.active_key_count),
    last_api_used_at: (r.last_api_used_at as string | null) ?? null,
    created_at: String(r.created_at),
    activated_at: (r.activated_at as string | null) ?? null,
    pending_meter_count: int(r.pending_meter_count),
    linkable_quarantine_count: int(r.linkable_quarantine_count)
  };
};

export interface CustomerDetailRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  panel_enabled: boolean;
  integration_mode: "panel" | "api";
  panel_username: string | null;
  created_at: string;
  activated_at: string | null;
}

const toCustomerDetail = (r: Record<string, unknown>): CustomerDetailRow => ({
  id: String(r.id),
  name: String(r.name),
  phone: (r.phone as string | null) ?? null,
  email: (r.email as string | null) ?? null,
  notes: (r.notes as string | null) ?? null,
  panel_enabled: r.panel_enabled === true,
  integration_mode: r.integration_mode === "api" ? "api" : "panel",
  panel_username: (r.panel_username as string | null) ?? null,
  created_at: String(r.created_at),
  activated_at: (r.activated_at as string | null) ?? null
});

export interface CustomerOnboardMeter {
  sn: string;
  unitNo?: string | null;
  meterUsage?: "prepaid" | "analysis";
}

export interface CreateCustomerAccountInput {
  name: string;
  phone: string;
  email?: string | null;
  notes?: string | null;
  username: string;
  passwordHash: string;
  /** panel = local UI login; api = third-party software via customer API keys. */
  integrationMode?: "panel" | "api";
  panelEnabled?: boolean;
  meters?: CustomerOnboardMeter[];
}

export interface CreateCustomerAccountResult {
  customer: CustomerDetailRow;
  panelUser: PanelUserPublic | null;
  metersRegistered: number;
}

/** Creates customer + linked panel viewer account in one transaction. */
export const createCustomerWithAccount = async (
  pool: Pool,
  input: CreateCustomerAccountInput
): Promise<CreateCustomerAccountResult> => {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const integrationMode = input.integrationMode === "api" ? "api" : "panel";
    const hasCreds = Boolean(input.username?.trim() && input.passwordHash);
    const panelOn =
      hasCreds &&
      (integrationMode === "panel" ? input.panelEnabled !== false : input.panelEnabled === true);
    const custRes = await client.query(
      `INSERT INTO customers (name, phone, email, notes, panel_enabled, integration_mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, phone, email, notes, panel_enabled, integration_mode, created_at`,
      [
        input.name,
        input.phone,
        input.email ?? null,
        input.notes ?? null,
        panelOn,
        integrationMode
      ]
    );
    const cust = custRes.rows[0]!;
    const customerId = String(cust.id);
    let panelUser: PanelUserPublic | null = null;
    if (panelOn) {
      const puRes = await client.query(
        `INSERT INTO panel_users (username, password_hash, role, customer_id)
         VALUES ($1, $2, 'viewer', $3)
         RETURNING *`,
        [input.username, input.passwordHash, customerId]
      );
      panelUser = {
        id: String(puRes.rows[0]!.id),
        username: String(puRes.rows[0]!.username),
        role: "viewer",
        is_active: true,
        customer_id: customerId,
        created_at: String(puRes.rows[0]!.created_at),
        last_login_at: null
      };
    }
    let metersRegistered = 0;
    const meters = input.meters ?? [];
    for (const m of meters) {
      const sn = m.sn.trim();
      if (!sn) continue;
      const unitNo = m.unitNo?.trim() || null;
      await registerDevice(client, {
        sn,
        customerId,
        unitNo,
        label: unitNo,
        meterUsage: m.meterUsage === "analysis" ? "analysis" : "prepaid"
      });
      metersRegistered += 1;
    }
    await client.query("COMMIT");
    return {
      customer: toCustomerDetail({
        ...cust,
        panel_username: panelUser?.username ?? null,
        activated_at: null
      }),
      panelUser,
      metersRegistered
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export const updateCustomer = async (
  pool: Pool,
  id: string,
  patch: { name?: string; phone?: string | null; email?: string | null; notes?: string | null; panelEnabled?: boolean }
): Promise<CustomerDetailRow | null> => {
  const res = await pool.query(
    `UPDATE customers SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone),
       email = COALESCE($4, email),
       notes = COALESCE($5, notes),
       panel_enabled = COALESCE($6, panel_enabled),
       updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, phone, email, notes, panel_enabled, integration_mode, created_at`,
    [
      id,
      patch.name ?? null,
      patch.phone ?? null,
      patch.email ?? null,
      patch.notes ?? null,
      patch.panelEnabled ?? null
    ]
  );
  return res.rows[0] ? toCustomerDetail(res.rows[0]) : null;
};

// ------------------------------------------------------------------ API keys

export interface ApiKeyRow {
  id: string;
  customer_id: string;
  label: string | null;
  key_prefix: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Public shape — never exposes key_hash. */
const toApiKey = (r: Record<string, unknown>): ApiKeyRow => ({
  id: String(r.id),
  customer_id: String(r.customer_id),
  label: (r.label as string | null) ?? null,
  key_prefix: String(r.key_prefix),
  is_active: r.is_active === true,
  created_at: String(r.created_at),
  last_used_at: (r.last_used_at as string | null) ?? null,
  revoked_at: (r.revoked_at as string | null) ?? null
});

export const listApiKeys = async (pool: Pool, customerId: string): Promise<ApiKeyRow[]> => {
  const res = await pool.query(
    "SELECT id, customer_id, label, key_prefix, is_active, created_at, last_used_at, revoked_at FROM customer_api_keys WHERE customer_id = $1 ORDER BY created_at DESC",
    [customerId]
  );
  return res.rows.map(toApiKey);
};

export const createApiKey = async (
  pool: Pool,
  input: { customerId: string; label: string | null; keyPrefix: string; keyHash: string }
): Promise<ApiKeyRow> => {
  const res = await pool.query(
    `INSERT INTO customer_api_keys (customer_id, label, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, customer_id, label, key_prefix, is_active, created_at, last_used_at, revoked_at`,
    [input.customerId, input.label, input.keyPrefix, input.keyHash]
  );
  return toApiKey(res.rows[0]!);
};

export const revokeApiKey = async (pool: Pool, id: string): Promise<ApiKeyRow | null> => {
  const res = await pool.query(
    `UPDATE customer_api_keys SET is_active = FALSE, revoked_at = NOW()
     WHERE id = $1
     RETURNING id, customer_id, label, key_prefix, is_active, created_at, last_used_at, revoked_at`,
    [id]
  );
  return res.rows[0] ? toApiKey(res.rows[0]) : null;
};

export interface ActiveApiKeyLookup {
  id: string;
  customer_id: string;
  customer_name: string;
}

/** Resolve an active key by its SHA-256 hash (used by the customer-API auth middleware). */
export const findActiveApiKeyByHash = async (
  pool: Pool,
  keyHash: string
): Promise<ActiveApiKeyLookup | null> => {
  const res = await pool.query(
    `SELECT k.id, k.customer_id, c.name AS customer_name
     FROM customer_api_keys k
     JOIN customers c ON c.id = k.customer_id
     WHERE k.key_hash = $1 AND k.is_active`,
    [keyHash]
  );
  const row = res.rows[0];
  return row
    ? { id: String(row.id), customer_id: String(row.customer_id), customer_name: String(row.customer_name) }
    : null;
};

/** Throttled last-used stamp: only writes when the previous use is older than the window. */
export const touchApiKeyUsage = async (pool: Pool, id: string, throttleSec = 60): Promise<void> => {
  const t = Math.max(0, Math.floor(throttleSec));
  await pool.query(
    `UPDATE customer_api_keys
     SET last_used_at = NOW()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '${t} seconds')`,
    [id]
  );
};
