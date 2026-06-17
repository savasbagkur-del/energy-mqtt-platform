import type { Pool } from "pg";
import type { RawMqttMessageInsert, RawMqttMessageRow } from "./types.js";

export const insertRawMqttMessage = async (
  pool: Pool,
  input: RawMqttMessageInsert
): Promise<void> => {
  await pool.query(
    `INSERT INTO raw_mqtt_messages (
      direction,
      topic,
      device_sn,
      product_key,
      protocol_msgid,
      method,
      payload,
      received_at,
      parse_status,
      parse_error
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10
    )`,
    [
      input.direction,
      input.topic,
      input.deviceSn,
      input.productKey,
      input.protocolMsgid,
      input.method,
      JSON.stringify(input.payload),
      input.receivedAt,
      input.parseStatus,
      input.parseError
    ]
  );
};

export const listRecentRawMqttMessages = async (
  pool: Pool,
  limit = 20
): Promise<RawMqttMessageRow[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 20;
  const result = await pool.query<RawMqttMessageRow>(
    `SELECT
      id,
      direction,
      topic,
      device_sn,
      product_key,
      protocol_msgid,
      method,
      payload,
      received_at,
      parse_status,
      parse_error,
      created_at
    FROM raw_mqtt_messages
    ORDER BY received_at DESC
    LIMIT $1`,
    [safeLimit]
  );

  return result.rows;
};

export const getLatestInboundRawMessageBySn = async (
  pool: Pool,
  sn: string
): Promise<RawMqttMessageRow | null> => {
  const result = await pool.query<RawMqttMessageRow>(
    `SELECT
      id,
      direction,
      topic,
      device_sn,
      product_key,
      protocol_msgid,
      method,
      payload,
      received_at,
      parse_status,
      parse_error,
      created_at
    FROM raw_mqtt_messages
    WHERE device_sn = $1
      AND direction = 'inbound'
    ORDER BY received_at DESC
    LIMIT 1`,
    [sn]
  );
  return result.rows[0] ?? null;
};

/** Latest parsed data/up (method update) inbound payload for a device — verify fallback when latest_state is thin. */
export const getLatestInboundUpdatePayloadBySn = async (
  pool: Pool,
  sn: string
): Promise<unknown | null> => {
  const result = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM raw_mqtt_messages
     WHERE device_sn = $1
       AND direction = 'inbound'
       AND method = 'update'
     ORDER BY received_at DESC
     LIMIT 1`,
    [sn]
  );
  return result.rows[0]?.payload ?? null;
};
