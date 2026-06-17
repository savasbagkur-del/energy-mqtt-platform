import type { Pool } from "pg";
import type { DeviceRow } from "./types.js";

export interface UpsertDeviceInput {
  sn: string;
  productKey: string | null;
  lastSeenAt: Date;
  lastMethod: string | null;
  devname: string | null;
  softcode: string | null;
  softversion: string | null;
  network: unknown;
  /**
   * When true, a brand-new (unknown) SN is recorded as 'quarantined' (visible but NOT managed)
   * instead of 'auto'. Existing registered/auto devices keep their status. Default false keeps the
   * legacy auto-registration behavior.
   */
  whitelistEnabled?: boolean;
}

const DEVICE_COLUMNS = `
  sn,
  product_key,
  last_seen_at,
  last_method,
  devname,
  softcode,
  softversion,
  network,
  updated_at,
  registry_status,
  lifecycle_status,
  registered_at,
  commissioned_at`;

export const upsertDevice = async (
  pool: Pool,
  input: UpsertDeviceInput
): Promise<void> => {
  const networkJson =
    input.network === undefined || input.network === null
      ? null
      : JSON.stringify(input.network);
  const newStatus = input.whitelistEnabled ? "quarantined" : "auto";

  await pool.query(
    `INSERT INTO devices (
      sn,
      product_key,
      last_seen_at,
      last_method,
      devname,
      softcode,
      softversion,
      network,
      registry_status,
      lifecycle_status,
      commissioned_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
      $9,
      CASE WHEN $9 = 'quarantined' THEN 'unknown' ELSE 'commissioned' END,
      CASE WHEN $9 = 'quarantined' THEN NULL ELSE $3 END,
      NOW()
    )
    ON CONFLICT (sn) DO UPDATE SET
      product_key = COALESCE(EXCLUDED.product_key, devices.product_key),
      last_seen_at = EXCLUDED.last_seen_at,
      last_method = EXCLUDED.last_method,
      devname = COALESCE(EXCLUDED.devname, devices.devname),
      softcode = COALESCE(EXCLUDED.softcode, devices.softcode),
      softversion = COALESCE(EXCLUDED.softversion, devices.softversion),
      network = COALESCE(EXCLUDED.network, devices.network),
      -- First contact commissions a managed device; quarantined rows keep their status untouched.
      commissioned_at = CASE
        WHEN devices.registry_status = 'quarantined' THEN devices.commissioned_at
        ELSE COALESCE(devices.commissioned_at, EXCLUDED.last_seen_at)
      END,
      lifecycle_status = CASE
        WHEN devices.registry_status = 'quarantined' THEN devices.lifecycle_status
        ELSE 'active'
      END,
      updated_at = NOW()`,
    [
      input.sn,
      input.productKey,
      input.lastSeenAt,
      input.lastMethod,
      input.devname,
      input.softcode,
      input.softversion,
      networkJson,
      newStatus
    ]
  );
};

export const listDevices = async (pool: Pool): Promise<DeviceRow[]> => {
  const result = await pool.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS}
    FROM devices
    ORDER BY last_seen_at DESC NULLS LAST`
  );
  return result.rows;
};

export const getDeviceBySn = async (
  pool: Pool,
  sn: string
): Promise<DeviceRow | null> => {
  const result = await pool.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS}
    FROM devices
    WHERE sn = $1`,
    [sn]
  );
  return result.rows[0] ?? null;
};
