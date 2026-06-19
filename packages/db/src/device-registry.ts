import type { Pool, PoolClient } from "pg";
import type { CustomerRow, DeviceRegistryRow, PropertyTypeRow } from "./types.js";

// ---- property types -------------------------------------------------------

export const listPropertyTypes = async (pool: Pool): Promise<PropertyTypeRow[]> => {
  const res = await pool.query<PropertyTypeRow>(
    "SELECT id, code, label, sort_order FROM property_types ORDER BY sort_order, label"
  );
  return res.rows;
};

export const createPropertyType = async (
  pool: Pool,
  input: { code: string; label: string; sortOrder?: number }
): Promise<PropertyTypeRow> => {
  const res = await pool.query<PropertyTypeRow>(
    `INSERT INTO property_types (code, label, sort_order)
     VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order
     RETURNING id, code, label, sort_order`,
    [input.code, input.label, input.sortOrder ?? 0]
  );
  return res.rows[0]!;
};

// ---- customers ------------------------------------------------------------

export const listCustomers = async (pool: Pool): Promise<CustomerRow[]> => {
  const res = await pool.query<CustomerRow>(
    "SELECT id, name, phone, email, notes, created_at, updated_at FROM customers ORDER BY name"
  );
  return res.rows;
};

export const getCustomer = async (pool: Pool, id: string): Promise<CustomerRow | null> => {
  const res = await pool.query<CustomerRow>(
    "SELECT id, name, phone, email, notes, created_at, updated_at FROM customers WHERE id = $1",
    [id]
  );
  return res.rows[0] ?? null;
};

export const createCustomer = async (
  pool: Pool,
  input: { name: string; phone?: string | null; email?: string | null; notes?: string | null }
): Promise<CustomerRow> => {
  const res = await pool.query<CustomerRow>(
    `INSERT INTO customers (name, phone, email, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, phone, email, notes, created_at, updated_at`,
    [input.name, input.phone ?? null, input.email ?? null, input.notes ?? null]
  );
  return res.rows[0]!;
};

// ---- device registry ------------------------------------------------------

export interface DeviceMetadataInput {
  sn: string;
  productKey?: string | null;
  label?: string | null;
  subscriberNo?: string | null;
  customerId?: string | null;
  propertyTypeId?: number | null;
  addressLine?: string | null;
  district?: string | null;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
  tariff?: string | null;
  region?: string | null;
  dealer?: string | null;
  installDate?: string | null;
  notes?: string | null;
  /** 'consumption' | 'analysis' | null — which metrics to persist for this device. */
  telemetryMode?: string | null;
}

const REGISTRY_SELECT = `
  SELECT
    d.sn, d.product_key, d.label, d.subscriber_no,
    d.customer_id::text AS customer_id, c.name AS customer_name,
    d.property_type_id, pt.code AS property_type_code, pt.label AS property_type_label,
    d.address_line, d.district, d.city, d.lat, d.lng,
    d.tariff, d.region, d.dealer, d.install_date, d.notes, d.telemetry_mode, d.model,
    d.registry_status, d.lifecycle_status, d.registered_at, d.commissioned_at, d.last_seen_at
  FROM devices d
  LEFT JOIN customers c ON c.id = d.customer_id
  LEFT JOIN property_types pt ON pt.id = d.property_type_id`;

/**
 * Register a device (pre-registration or metadata update). Creates the row if missing with
 * registry_status='registered' so it is whitelisted; on conflict it sets registry_status to
 * 'registered' (promoting a quarantined/auto device) and patches the supplied metadata.
 * Only provided fields are changed (COALESCE keeps existing values for omitted fields).
 */
export const registerDevice = async (
  client: Pool | PoolClient,
  input: DeviceMetadataInput
): Promise<void> => {
  await client.query(
    `INSERT INTO devices (
      sn, product_key, label, subscriber_no, customer_id, property_type_id,
      address_line, district, city, lat, lng, tariff, region, dealer, install_date, notes,
      telemetry_mode,
      registry_status, lifecycle_status, registered_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
      'registered', 'registered', NOW(), NOW()
    )
    ON CONFLICT (sn) DO UPDATE SET
      product_key = COALESCE(EXCLUDED.product_key, devices.product_key),
      label = COALESCE(EXCLUDED.label, devices.label),
      subscriber_no = COALESCE(EXCLUDED.subscriber_no, devices.subscriber_no),
      customer_id = COALESCE(EXCLUDED.customer_id, devices.customer_id),
      property_type_id = COALESCE(EXCLUDED.property_type_id, devices.property_type_id),
      address_line = COALESCE(EXCLUDED.address_line, devices.address_line),
      district = COALESCE(EXCLUDED.district, devices.district),
      city = COALESCE(EXCLUDED.city, devices.city),
      lat = COALESCE(EXCLUDED.lat, devices.lat),
      lng = COALESCE(EXCLUDED.lng, devices.lng),
      tariff = COALESCE(EXCLUDED.tariff, devices.tariff),
      region = COALESCE(EXCLUDED.region, devices.region),
      dealer = COALESCE(EXCLUDED.dealer, devices.dealer),
      install_date = COALESCE(EXCLUDED.install_date, devices.install_date),
      notes = COALESCE(EXCLUDED.notes, devices.notes),
      telemetry_mode = COALESCE(EXCLUDED.telemetry_mode, devices.telemetry_mode),
      registry_status = 'registered',
      registered_at = COALESCE(devices.registered_at, NOW()),
      -- promote a never-contacted registration to 'registered' lifecycle; keep contacted state
      lifecycle_status = CASE WHEN devices.last_seen_at IS NULL THEN 'registered' ELSE devices.lifecycle_status END,
      updated_at = NOW()`,
    [
      input.sn,
      input.productKey ?? null,
      input.label ?? null,
      input.subscriberNo ?? null,
      input.customerId ?? null,
      input.propertyTypeId ?? null,
      input.addressLine ?? null,
      input.district ?? null,
      input.city ?? null,
      input.lat ?? null,
      input.lng ?? null,
      input.tariff ?? null,
      input.region ?? null,
      input.dealer ?? null,
      input.installDate ?? null,
      input.notes ?? null,
      input.telemetryMode ?? null
    ]
  );
};

export interface BulkRegisterResult {
  total: number;
  ok: number;
  failed: Array<{ sn: string; error: string }>;
}

/** Transactional bulk registration for CSV/Excel import. */
export const bulkRegisterDevices = async (
  pool: Pool,
  rows: DeviceMetadataInput[]
): Promise<BulkRegisterResult> => {
  const result: BulkRegisterResult = { total: rows.length, ok: 0, failed: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      if (!row.sn || row.sn.trim().length === 0) {
        result.failed.push({ sn: row.sn ?? "", error: "missing_sn" });
        continue;
      }
      try {
        await registerDevice(client, row);
        result.ok += 1;
      } catch (error) {
        result.failed.push({ sn: row.sn, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return result;
};

export const getDeviceRegistry = async (pool: Pool, sn: string): Promise<DeviceRegistryRow | null> => {
  const res = await pool.query<DeviceRegistryRow>(`${REGISTRY_SELECT} WHERE d.sn = $1`, [sn]);
  return res.rows[0] ?? null;
};

export interface ListDevicesRegistryFilter {
  status?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

export const listDevicesRegistry = async (
  pool: Pool,
  filter: ListDevicesRegistryFilter = {}
): Promise<DeviceRegistryRow[]> => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    params.push(filter.status);
    where.push(`d.registry_status = $${params.length}`);
  }
  if (filter.search) {
    params.push(`%${filter.search}%`);
    const i = params.length;
    where.push(`(d.sn ILIKE $${i} OR d.label ILIKE $${i} OR d.subscriber_no ILIKE $${i} OR c.name ILIKE $${i})`);
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const offset = Math.max(filter.offset ?? 0, 0);
  params.push(limit, offset);
  const sql = `${REGISTRY_SELECT}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY d.last_seen_at DESC NULLS LAST
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const res = await pool.query<DeviceRegistryRow>(sql, params);
  return res.rows;
};

/** Approve a quarantined device into the managed whitelist. */
// Required metadata before a quarantined device can be approved/whitelisted.
// A device must not be admitted to the fleet without an owner and core details.
const APPROVAL_REQUIRED_FIELDS: { key: keyof DeviceRegistryRow; label: string }[] = [
  { key: "customer_id", label: "Müşteri (kimin adına)" },
  { key: "subscriber_no", label: "Abone No" },
  { key: "property_type_id", label: "Mülk tipi" },
  { key: "city", label: "Şehir" }
];

export interface ApprovalReadiness {
  found: boolean;
  quarantined: boolean;
  missing: string[];
}

const isBlank = (value: unknown): boolean =>
  value == null || (typeof value === "string" && value.trim() === "");

export const checkDeviceApprovalReadiness = async (
  pool: Pool,
  sn: string
): Promise<ApprovalReadiness> => {
  const row = await getDeviceRegistry(pool, sn);
  if (!row) return { found: false, quarantined: false, missing: [] };
  const missing = APPROVAL_REQUIRED_FIELDS.filter((f) => isBlank(row[f.key])).map(
    (f) => f.label
  );
  return {
    found: true,
    quarantined: row.registry_status === "quarantined",
    missing
  };
};

export const approveQuarantinedDevice = async (pool: Pool, sn: string): Promise<boolean> => {
  const res = await pool.query(
    `UPDATE devices SET
       registry_status = 'registered',
       registered_at = COALESCE(registered_at, NOW()),
       lifecycle_status = CASE WHEN last_seen_at IS NULL THEN 'registered' ELSE 'active' END,
       updated_at = NOW()
     WHERE sn = $1 AND registry_status = 'quarantined'`,
    [sn]
  );
  return (res.rowCount ?? 0) > 0;
};

export const setDeviceLifecycle = async (
  pool: Pool,
  sn: string,
  lifecycle: "registered" | "commissioned" | "active" | "decommissioned"
): Promise<boolean> => {
  const res = await pool.query(
    "UPDATE devices SET lifecycle_status = $2, updated_at = NOW() WHERE sn = $1",
    [sn, lifecycle]
  );
  return (res.rowCount ?? 0) > 0;
};
