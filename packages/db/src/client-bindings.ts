import type { Pool } from "pg";
import type { MqttClientBindingRow } from "./types.js";

/**
 * Learn a clientid <-> (product_key, sn) binding from observed traffic. Populated by an EMQX
 * rule that republishes `message.publish` (clientid + topic) so presence events (which carry
 * only clientid) can be resolved to device sn(s), including gateway/concentrator topologies.
 */
export const upsertClientBinding = async (
  pool: Pool,
  input: { clientid: string; productKey?: string | null; sn?: string | null; gatewayClientId?: string | null }
): Promise<void> => {
  await pool.query(
    `INSERT INTO mqtt_client_bindings (clientid, product_key, sn, gateway_clientid, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (clientid) DO UPDATE SET
       product_key = COALESCE(EXCLUDED.product_key, mqtt_client_bindings.product_key),
       sn = COALESCE(EXCLUDED.sn, mqtt_client_bindings.sn),
       gateway_clientid = COALESCE(EXCLUDED.gateway_clientid, mqtt_client_bindings.gateway_clientid),
       last_seen_at = NOW()`,
    [input.clientid, input.productKey ?? null, input.sn ?? null, input.gatewayClientId ?? null]
  );
};

/** All sns known to be served by this MQTT clientid (direct sn or gateway children). */
export const resolveSnsForClientId = async (
  pool: Pool,
  clientid: string
): Promise<string[]> => {
  const result = await pool.query<{ sn: string }>(
    `SELECT DISTINCT sn FROM mqtt_client_bindings
     WHERE sn IS NOT NULL AND (clientid = $1 OR gateway_clientid = $1)`,
    [clientid]
  );
  return result.rows.map((r) => r.sn);
};

export const getClientBinding = async (
  pool: Pool,
  clientid: string
): Promise<MqttClientBindingRow | null> => {
  const result = await pool.query<MqttClientBindingRow>(
    `SELECT * FROM mqtt_client_bindings WHERE clientid = $1`,
    [clientid]
  );
  return result.rows[0] ?? null;
};
