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
}

export const upsertDevice = async (
  pool: Pool,
  input: UpsertDeviceInput
): Promise<void> => {
  const networkJson =
    input.network === undefined || input.network === null
      ? null
      : JSON.stringify(input.network);

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
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
    ON CONFLICT (sn) DO UPDATE SET
      product_key = COALESCE(EXCLUDED.product_key, devices.product_key),
      last_seen_at = EXCLUDED.last_seen_at,
      last_method = EXCLUDED.last_method,
      devname = COALESCE(EXCLUDED.devname, devices.devname),
      softcode = COALESCE(EXCLUDED.softcode, devices.softcode),
      softversion = COALESCE(EXCLUDED.softversion, devices.softversion),
      network = COALESCE(EXCLUDED.network, devices.network),
      updated_at = NOW()`,
    [
      input.sn,
      input.productKey,
      input.lastSeenAt,
      input.lastMethod,
      input.devname,
      input.softcode,
      input.softversion,
      networkJson
    ]
  );
};

export const listDevices = async (pool: Pool): Promise<DeviceRow[]> => {
  const result = await pool.query<DeviceRow>(
    `SELECT
      sn,
      product_key,
      last_seen_at,
      last_method,
      devname,
      softcode,
      softversion,
      network,
      updated_at
    FROM devices
    ORDER BY last_seen_at DESC`
  );
  return result.rows;
};

export const getDeviceBySn = async (
  pool: Pool,
  sn: string
): Promise<DeviceRow | null> => {
  const result = await pool.query<DeviceRow>(
    `SELECT
      sn,
      product_key,
      last_seen_at,
      last_method,
      devname,
      softcode,
      softversion,
      network,
      updated_at
    FROM devices
    WHERE sn = $1`,
    [sn]
  );
  return result.rows[0] ?? null;
};
