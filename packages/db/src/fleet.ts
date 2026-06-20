import type { Pool } from "pg";

/**
 * Fleet-wide read models for the operator dashboard. All aggregation happens in PostgreSQL
 * (single indexed query per request) so the browser never has to fan out N+1 calls — this is
 * what keeps the UI responsive at 10k+ devices.
 */

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
};

// pg returns NUMERIC/COUNT as strings; normalise to JS numbers (or null) at the edge.
const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};
const int = (value: unknown): number => Math.trunc(num(value) ?? 0);

export interface FleetOverview {
  total: number;
  registered: number;
  auto: number;
  quarantined: number;
  managed: number;
  online: number;
  offline: number;
  switchOn: number;
  switchOff: number;
  owing: number;
  alarms: number;
  new24h: number;
  totalActivePowerKw: number;
  totalEnergyKwh: number;
  avgRssi: number | null;
  onlineWindowSec: number;
  generatedAt: string;
}

export const getFleetOverview = async (
  pool: Pool,
  onlineWindowSec = 300
): Promise<FleetOverview> => {
  const win = String(clampInt(onlineWindowSec, 300, 30, 86400));
  const res = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE d.registry_status = 'registered') AS registered,
       COUNT(*) FILTER (WHERE d.registry_status = 'auto') AS auto,
       COUNT(*) FILTER (WHERE d.registry_status = 'quarantined') AS quarantined,
       COUNT(*) FILTER (WHERE ls.last_seen_at >= NOW() - ($1 || ' seconds')::interval) AS online,
       COUNT(*) FILTER (WHERE ls.switch_state = 1) AS switch_on,
       COUNT(*) FILTER (WHERE ls.switch_state = 0) AS switch_off,
       COUNT(*) FILTER (WHERE COALESCE(ls.owe_money, 0) > 0) AS owing,
       COUNT(*) FILTER (WHERE COALESCE(ls.alarm_a, 0) > 0 OR COALESCE(ls.alarm_b, 0) > 0) AS alarms,
       COUNT(*) FILTER (
         WHERE d.registered_at >= NOW() - INTERVAL '24 hours'
            OR d.commissioned_at >= NOW() - INTERVAL '24 hours'
       ) AS new_24h,
       COALESCE(SUM(ls.active_power_kw) FILTER (
         WHERE ls.last_seen_at >= NOW() - ($1 || ' seconds')::interval
       ), 0) AS total_active_power_kw,
       COALESCE(SUM(ls.energy_import_kwh), 0) AS total_energy_kwh,
       AVG(ls.rssi) FILTER (
         WHERE ls.last_seen_at >= NOW() - ($1 || ' seconds')::interval
       ) AS avg_rssi
     FROM devices d
     LEFT JOIN device_latest_state ls ON ls.sn = d.sn`,
    [win]
  );
  const r = res.rows[0] ?? {};
  const registered = int(r.registered);
  const auto = int(r.auto);
  const managed = registered + auto;
  const online = int(r.online);
  return {
    total: int(r.total),
    registered,
    auto,
    quarantined: int(r.quarantined),
    managed,
    online,
    offline: Math.max(managed - online, 0),
    switchOn: int(r.switch_on),
    switchOff: int(r.switch_off),
    owing: int(r.owing),
    alarms: int(r.alarms),
    new24h: int(r.new_24h),
    totalActivePowerKw: num(r.total_active_power_kw) ?? 0,
    totalEnergyKwh: num(r.total_energy_kwh) ?? 0,
    avgRssi: num(r.avg_rssi),
    onlineWindowSec: Number(win),
    generatedAt: new Date().toISOString()
  };
};

export interface FleetDeviceRow {
  sn: string;
  label: string | null;
  subscriber_no: string | null;
  customer_name: string | null;
  property_type_label: string | null;
  city: string | null;
  district: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  model: string | null;
  telemetry_mode: string | null;
  registry_status: string;
  lifecycle_status: string;
  last_seen_at: string | null;
  online: boolean;
  voltage_v: number | null;
  current_a: number | null;
  active_power_kw: number | null;
  power_factor: number | null;
  energy_import_kwh: number | null;
  balance: number | null;
  switch_state: number | null;
  owe_money: number | null;
  alarm_a: number | null;
  alarm_b: number | null;
  rssi: number | null;
}

export interface ListFleetDevicesFilter {
  status?: string | null;
  search?: string | null;
  online?: boolean | null;
  /** Only devices currently reporting an alarm (alarm_a/alarm_b > 0). */
  alarm?: boolean | null;
  /** Only devices with an outstanding balance (owe_money > 0). */
  owing?: boolean | null;
  onlineWindowSec?: number;
  limit?: number;
  offset?: number;
}

export interface ListFleetDevicesResult {
  items: FleetDeviceRow[];
  total: number;
}

const normaliseFleetRow = (r: Record<string, unknown>): FleetDeviceRow => ({
  sn: String(r.sn),
  label: (r.label as string) ?? null,
  subscriber_no: (r.subscriber_no as string) ?? null,
  customer_name: (r.customer_name as string) ?? null,
  property_type_label: (r.property_type_label as string) ?? null,
  city: (r.city as string) ?? null,
  district: (r.district as string) ?? null,
  region: (r.region as string) ?? null,
  lat: num(r.lat),
  lng: num(r.lng),
  model: (r.model as string) ?? null,
  telemetry_mode: (r.telemetry_mode as string) ?? null,
  registry_status: String(r.registry_status),
  lifecycle_status: String(r.lifecycle_status),
  last_seen_at: (r.last_seen_at as string) ?? null,
  online: r.online === true,
  voltage_v: num(r.voltage_v),
  current_a: num(r.current_a),
  active_power_kw: num(r.active_power_kw),
  power_factor: num(r.power_factor),
  energy_import_kwh: num(r.energy_import_kwh),
  balance: num(r.balance),
  switch_state: num(r.switch_state),
  owe_money: num(r.owe_money),
  alarm_a: num(r.alarm_a),
  alarm_b: num(r.alarm_b),
  rssi: num(r.rssi)
});

export const listFleetDevices = async (
  pool: Pool,
  filter: ListFleetDevicesFilter = {}
): Promise<ListFleetDevicesResult> => {
  // win is a validated integer (clampInt), so it is safe to interpolate directly. Keeping it out
  // of the positional params means the count query (which omits the SELECT online flag) stays clean.
  const win = clampInt(filter.onlineWindowSec, 300, 30, 86400);
  const onlineExpr = `ls.last_seen_at >= NOW() - INTERVAL '${win} seconds'`;
  const params: unknown[] = [];
  const where: string[] = [];

  if (filter.status) {
    params.push(filter.status);
    where.push(`d.registry_status = $${params.length}`);
  }
  if (filter.search) {
    params.push(`%${filter.search}%`);
    const i = params.length;
    where.push(
      `(d.sn ILIKE $${i} OR d.label ILIKE $${i} OR d.subscriber_no ILIKE $${i} OR c.name ILIKE $${i} OR d.city ILIKE $${i})`
    );
  }
  if (filter.online === true) {
    where.push(onlineExpr);
  } else if (filter.online === false) {
    where.push(`(ls.last_seen_at IS NULL OR NOT (${onlineExpr}))`);
  }
  if (filter.alarm === true) {
    where.push(`(COALESCE(ls.alarm_a, 0) > 0 OR COALESCE(ls.alarm_b, 0) > 0)`);
  }
  if (filter.owing === true) {
    where.push(`COALESCE(ls.owe_money, 0) > 0`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const fromSql = `
    FROM devices d
    LEFT JOIN customers c ON c.id = d.customer_id
    LEFT JOIN property_types pt ON pt.id = d.property_type_id
    LEFT JOIN device_latest_state ls ON ls.sn = d.sn
    ${whereSql}`;

  const selectCols = `
    d.sn, d.label, d.subscriber_no,
    c.name AS customer_name,
    pt.label AS property_type_label,
    d.city, d.district, d.region, d.lat, d.lng,
    d.model, d.telemetry_mode,
    d.registry_status, d.lifecycle_status,
    COALESCE(ls.last_seen_at, d.last_seen_at) AS last_seen_at,
    (${onlineExpr}) AS online,
    ls.voltage_v, ls.current_a, ls.active_power_kw, ls.power_factor,
    ls.energy_import_kwh, ls.balance, ls.switch_state, ls.owe_money,
    ls.alarm_a, ls.alarm_b, ls.rssi`;

  const limit = clampInt(filter.limit, 50, 1, 500);
  const offset = clampInt(filter.offset, 0, 0, 10_000_000);
  params.push(limit, offset);

  const listSql = `SELECT ${selectCols} ${fromSql}
    ORDER BY online DESC NULLS LAST, COALESCE(ls.last_seen_at, d.last_seen_at) DESC NULLS LAST, d.sn
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  // Count query reuses the same WHERE params except limit/offset.
  const countParams = params.slice(0, params.length - 2);
  const countSql = `SELECT COUNT(*)::bigint AS total ${fromSql}`;

  const [listRes, countRes] = await Promise.all([
    pool.query(listSql, params),
    pool.query(countSql, countParams)
  ]);

  return {
    items: listRes.rows.map((row) => normaliseFleetRow(row as Record<string, unknown>)),
    total: int(countRes.rows[0]?.total)
  };
};

export interface DeviceTelemetrySnapshot {
  sn: string;
  product_key: string;
  last_seen_at: string;
  last_method: string;
  last_topic: string;
  source: string | null;
  voltage_v: number | null;
  current_a: number | null;
  active_power_kw: number | null;
  reactive_power_kvar: number | null;
  power_factor: number | null;
  energy_import_kwh: number | null;
  balance: number | null;
  switch_state: number | null;
  prestate: string | null;
  owe_money: number | null;
  alarm_a: number | null;
  alarm_b: number | null;
  adf_state_1: string | null;
  adf_state_2: string | null;
  rssi: number | null;
  channel: number | null;
  mac_address: string | null;
  voltage_b_v: number | null;
  voltage_c_v: number | null;
  current_b_a: number | null;
  current_c_a: number | null;
  active_power_a_kw: number | null;
  active_power_b_kw: number | null;
  active_power_c_kw: number | null;
  power_factor_a: number | null;
  power_factor_b: number | null;
  power_factor_c: number | null;
  energy_sharp_kwh: number | null;
  energy_peak_kwh: number | null;
  energy_flat_kwh: number | null;
  energy_valley_kwh: number | null;
  max_demand_kw: number | null;
  updated_at: string;
}

export const getDeviceTelemetry = async (
  pool: Pool,
  sn: string
): Promise<DeviceTelemetrySnapshot | null> => {
  const res = await pool.query(
    `SELECT sn, product_key, last_seen_at, last_method, last_topic, source,
            voltage_v, current_a, active_power_kw, reactive_power_kvar, power_factor,
            energy_import_kwh, balance, switch_state, prestate, owe_money,
            alarm_a, alarm_b, adf_state_1, adf_state_2, rssi, channel, mac_address,
            voltage_b_v, voltage_c_v, current_b_a, current_c_a,
            active_power_a_kw, active_power_b_kw, active_power_c_kw,
            power_factor_a, power_factor_b, power_factor_c,
            energy_sharp_kwh, energy_peak_kwh, energy_flat_kwh, energy_valley_kwh,
            max_demand_kw, updated_at
     FROM device_latest_state WHERE sn = $1`,
    [sn]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    sn: String(r.sn),
    product_key: String(r.product_key),
    last_seen_at: r.last_seen_at as string,
    last_method: r.last_method as string,
    last_topic: r.last_topic as string,
    source: (r.source as string) ?? null,
    voltage_v: num(r.voltage_v),
    current_a: num(r.current_a),
    active_power_kw: num(r.active_power_kw),
    reactive_power_kvar: num(r.reactive_power_kvar),
    power_factor: num(r.power_factor),
    energy_import_kwh: num(r.energy_import_kwh),
    balance: num(r.balance),
    switch_state: num(r.switch_state),
    prestate: (r.prestate as string) ?? null,
    owe_money: num(r.owe_money),
    alarm_a: num(r.alarm_a),
    alarm_b: num(r.alarm_b),
    adf_state_1: (r.adf_state_1 as string) ?? null,
    adf_state_2: (r.adf_state_2 as string) ?? null,
    rssi: num(r.rssi),
    channel: num(r.channel),
    mac_address: (r.mac_address as string) ?? null,
    voltage_b_v: num(r.voltage_b_v),
    voltage_c_v: num(r.voltage_c_v),
    current_b_a: num(r.current_b_a),
    current_c_a: num(r.current_c_a),
    active_power_a_kw: num(r.active_power_a_kw),
    active_power_b_kw: num(r.active_power_b_kw),
    active_power_c_kw: num(r.active_power_c_kw),
    power_factor_a: num(r.power_factor_a),
    power_factor_b: num(r.power_factor_b),
    power_factor_c: num(r.power_factor_c),
    energy_sharp_kwh: num(r.energy_sharp_kwh),
    energy_peak_kwh: num(r.energy_peak_kwh),
    energy_flat_kwh: num(r.energy_flat_kwh),
    energy_valley_kwh: num(r.energy_valley_kwh),
    max_demand_kw: num(r.max_demand_kw),
    updated_at: r.updated_at as string
  };
};

export interface TelemetrySeriesPoint {
  t: string;
  voltage_v: number | null;
  current_a: number | null;
  active_power_kw: number | null;
  power_factor: number | null;
  energy_import_kwh: number | null;
  rssi: number | null;
  switch_state: number | null;
  voltage_b_v: number | null;
  voltage_c_v: number | null;
  current_b_a: number | null;
  current_c_a: number | null;
  active_power_a_kw: number | null;
  active_power_b_kw: number | null;
  active_power_c_kw: number | null;
  samples: number;
}

export interface TelemetrySeriesOptions {
  sinceSec?: number;
  bucketSec?: number;
}

export const getTelemetrySeries = async (
  pool: Pool,
  sn: string,
  options: TelemetrySeriesOptions = {}
): Promise<TelemetrySeriesPoint[]> => {
  const sinceSec = clampInt(options.sinceSec, 24 * 3600, 60, 90 * 86400);
  const bucketSec = clampInt(options.bucketSec, 300, 10, 86400);
  const res = await pool.query(
    `SELECT
       to_timestamp(floor(extract(epoch FROM observed_at) / $2) * $2) AS t,
       AVG(voltage_v) AS voltage_v,
       AVG(current_a) AS current_a,
       AVG(active_power_kw) AS active_power_kw,
       AVG(power_factor) AS power_factor,
       MAX(energy_import_kwh) AS energy_import_kwh,
       AVG(rssi) AS rssi,
       MAX(switch_state) AS switch_state,
       AVG(voltage_b_v) AS voltage_b_v,
       AVG(voltage_c_v) AS voltage_c_v,
       AVG(current_b_a) AS current_b_a,
       AVG(current_c_a) AS current_c_a,
       AVG(active_power_a_kw) AS active_power_a_kw,
       AVG(active_power_b_kw) AS active_power_b_kw,
       AVG(active_power_c_kw) AS active_power_c_kw,
       COUNT(*) AS samples
     FROM telemetry_samples
     WHERE sn = $1 AND observed_at >= NOW() - ($3 || ' seconds')::interval
     GROUP BY 1
     ORDER BY 1`,
    [sn, String(bucketSec), String(sinceSec)]
  );
  return res.rows.map((r) => ({
    t: new Date(r.t as string).toISOString(),
    voltage_v: num(r.voltage_v),
    current_a: num(r.current_a),
    active_power_kw: num(r.active_power_kw),
    power_factor: num(r.power_factor),
    energy_import_kwh: num(r.energy_import_kwh),
    rssi: num(r.rssi),
    switch_state: num(r.switch_state),
    voltage_b_v: num(r.voltage_b_v),
    voltage_c_v: num(r.voltage_c_v),
    current_b_a: num(r.current_b_a),
    current_c_a: num(r.current_c_a),
    active_power_a_kw: num(r.active_power_a_kw),
    active_power_b_kw: num(r.active_power_b_kw),
    active_power_c_kw: num(r.active_power_c_kw),
    samples: int(r.samples)
  }));
};
