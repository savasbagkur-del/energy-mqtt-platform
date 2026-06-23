import type { Pool } from "pg";

/** Resolve a customer-owned device SN by daire/dükkan no (EasyTech roomNo). */
export const findDeviceSnByCustomerRoom = async (
  pool: Pool,
  customerId: string,
  roomNo: string
): Promise<string | null> => {
  const res = await pool.query<{ sn: string }>(
    `SELECT sn FROM devices
     WHERE customer_id = $1
       AND (unit_no = $2 OR label = $2)
     ORDER BY registered_at ASC NULLS LAST, sn ASC
     LIMIT 2`,
    [customerId, roomNo]
  );
  if (res.rows.length !== 1) return null;
  return String(res.rows[0]!.sn);
};
