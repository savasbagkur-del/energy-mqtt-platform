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

export interface ProjectOverviewRow {
  /** project_name; null bucket = devices with no project assigned yet. */
  projectName: string | null;
  total: number;
  online: number;
  offline: number;
  totalEnergyKwh: number;
  openAlarms: number;
  /** Earliest registration date of the customer(s) owning this project's devices. */
  customerSince: string | null;
  /** Distinct customers owning devices in this project (a customer may own several projects). */
  customerCount: number;
}

/**
 * Per-project rollup for the admin overview: managed (registered/auto) meters grouped by
 * devices.project_name with online/offline counts, summed energy index, and open command-alarm
 * counts (device_alarms ledger). Single grouped query — scales with the fleet, not the browser.
 */
export const getProjectOverview = async (
  pool: Pool,
  onlineWindowSec = 300
): Promise<ProjectOverviewRow[]> => {
  const win = String(clampInt(onlineWindowSec, 300, 30, 86400));
  const res = await pool.query(
    `SELECT
       d.project_name,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ls.last_seen_at >= NOW() - ($1 || ' seconds')::interval) AS online,
       COALESCE(SUM(ls.energy_import_kwh), 0) AS total_energy_kwh,
       COALESCE(SUM(COALESCE(oa.cnt, 0)), 0) AS open_alarms,
       MIN(c.created_at) AS customer_since,
       COUNT(DISTINCT d.customer_id) AS customer_count
     FROM devices d
     LEFT JOIN device_latest_state ls ON ls.sn = d.sn
     LEFT JOIN customers c ON c.id = d.customer_id
     LEFT JOIN (
       SELECT sn, COUNT(*) AS cnt FROM device_alarms WHERE status = 'open' GROUP BY sn
     ) oa ON oa.sn = d.sn
     WHERE d.registry_status IN ('registered', 'auto')
     GROUP BY d.project_name
     ORDER BY COUNT(*) DESC, d.project_name NULLS LAST`,
    [win]
  );
  return res.rows.map((r) => {
    const total = int(r.total);
    const online = int(r.online);
    return {
      projectName: (r.project_name as string | null) ?? null,
      total,
      online,
      offline: Math.max(total - online, 0),
      totalEnergyKwh: num(r.total_energy_kwh) ?? 0,
      openAlarms: int(r.open_alarms),
      customerSince: (r.customer_since as string | null) ?? null,
      customerCount: int(r.customer_count)
    };
  });
};

export interface BillingAllocationRow {
  /** customers.id; null = devices not linked to a customer. */
  customerId: number | null;
  /** customers.name; null = no customer. */
  customerName: string | null;
  /** project_name; null bucket = no project assigned. */
  projectName: string | null;
  /** Managed (billable) device count in this project. */
  devices: number;
  /** Currently-online devices (informational). */
  online: number;
  /** Summed energy index (informational). */
  totalEnergyKwh: number;
}

export interface BillingAllocation {
  totalDevices: number;
  items: BillingAllocationRow[];
  generatedAt: string;
}

/**
 * Per-project billable device counts for cost chargeback. The shared infrastructure bill is
 * allocated across projects by device share (project devices / total devices), so the API just
 * needs the counts — the monetary math (monthly cost + margin) is applied at the edge where the
 * operator-configured rate lives. Only managed meters (registered/auto) are billable; quarantined
 * devices are excluded.
 */
export const getBillingAllocation = async (
  pool: Pool,
  onlineWindowSec = 300
): Promise<BillingAllocation> => {
  const win = String(clampInt(onlineWindowSec, 300, 30, 86400));
  const res = await pool.query(
    `SELECT
       d.customer_id,
       c.name AS customer_name,
       d.project_name,
       COUNT(*) AS devices,
       COUNT(*) FILTER (WHERE ls.last_seen_at >= NOW() - ($1 || ' seconds')::interval) AS online,
       COALESCE(SUM(ls.energy_import_kwh), 0) AS total_energy_kwh
     FROM devices d
     LEFT JOIN device_latest_state ls ON ls.sn = d.sn
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE d.registry_status IN ('registered', 'auto')
     GROUP BY d.customer_id, c.name, d.project_name
     ORDER BY COUNT(*) DESC, c.name NULLS LAST, d.project_name NULLS LAST`,
    [win]
  );
  const items = res.rows.map((r) => ({
    customerId: r.customer_id === null || r.customer_id === undefined ? null : int(r.customer_id),
    customerName: (r.customer_name as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    devices: int(r.devices),
    online: int(r.online),
    totalEnergyKwh: num(r.total_energy_kwh) ?? 0
  }));
  const totalDevices = items.reduce((acc, it) => acc + it.devices, 0);
  return { totalDevices, items, generatedAt: new Date().toISOString() };
};

/** A roll-up node (counts that aggregate upward through the tree). */
export interface HierarchyStats {
  total: number;
  online: number;
  offline: number;
  totalEnergyKwh: number;
  openAlarms: number;
}

/** Leaf level: devices grouped by property type within a building (oda/daire/dükkan/...). */
export interface HierarchyUnitNode extends HierarchyStats {
  /** property_types.label; null = type not set. */
  unitLabel: string | null;
}

/** Building level (devices.project_name). */
export interface HierarchyBuildingNode extends HierarchyStats {
  /** project_name; null = no building assigned. */
  buildingName: string | null;
  units: HierarchyUnitNode[];
}

/** Site / campus level (devices.site_name), one above the building. */
export interface HierarchySiteNode extends HierarchyStats {
  /** site_name; null = no site assigned. */
  siteName: string | null;
  buildings: HierarchyBuildingNode[];
}

/** Top level: a customer and everything they own. */
export interface CustomerHierarchyRow extends HierarchyStats {
  /** customers.id as string; null = devices not linked to any customer yet. */
  customerId: string | null;
  customerName: string | null;
  customerSince: string | null;
  sites: HierarchySiteNode[];
}

const addStats = (target: HierarchyStats, s: HierarchyStats): void => {
  target.total += s.total;
  target.online += s.online;
  target.offline += s.offline;
  target.totalEnergyKwh += s.totalEnergyKwh;
  target.openAlarms += s.openAlarms;
};

/**
 * Full customer → site → building → unit-type hierarchy for the overview flow chart. One grouped
 * query over (customer, site_name, project_name, property type); assembled into a 4-level tree in
 * JS where every level's counts are the sum of its children (rolls up toward the customer/root).
 * Devices with no customer/site/building/type fall into trailing null buckets so nothing is
 * hidden. Scales with the fleet, not the browser.
 */
export const getCustomerHierarchy = async (
  pool: Pool,
  onlineWindowSec = 300
): Promise<CustomerHierarchyRow[]> => {
  const win = String(clampInt(onlineWindowSec, 300, 30, 86400));
  const res = await pool.query(
    `SELECT
       d.customer_id,
       c.name AS customer_name,
       c.created_at AS customer_since,
       d.site_name,
       d.project_name,
       pt.label AS unit_label,
       pt.sort_order AS unit_sort,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ls.last_seen_at >= NOW() - ($1 || ' seconds')::interval) AS online,
       COALESCE(SUM(ls.energy_import_kwh), 0) AS total_energy_kwh,
       COALESCE(SUM(COALESCE(oa.cnt, 0)), 0) AS open_alarms
     FROM devices d
     LEFT JOIN device_latest_state ls ON ls.sn = d.sn
     LEFT JOIN customers c ON c.id = d.customer_id
     LEFT JOIN property_types pt ON pt.id = d.property_type_id
     LEFT JOIN (
       SELECT sn, COUNT(*) AS cnt FROM device_alarms WHERE status = 'open' GROUP BY sn
     ) oa ON oa.sn = d.sn
     WHERE d.registry_status IN ('registered', 'auto')
     GROUP BY d.customer_id, c.name, c.created_at, d.site_name, d.project_name, pt.label, pt.sort_order
     ORDER BY (d.customer_id IS NULL), c.name NULLS LAST, d.site_name NULLS LAST,
              d.project_name NULLS LAST, pt.sort_order NULLS LAST, pt.label NULLS LAST`,
    [win]
  );
  const byCustomer = new Map<string, CustomerHierarchyRow>();
  for (const r of res.rows) {
    const cid = r.customer_id == null ? null : String(r.customer_id);
    const ckey = cid ?? "__none__";
    let cust = byCustomer.get(ckey);
    if (!cust) {
      cust = {
        customerId: cid,
        customerName: (r.customer_name as string | null) ?? null,
        customerSince: (r.customer_since as string | null) ?? null,
        total: 0,
        online: 0,
        offline: 0,
        totalEnergyKwh: 0,
        openAlarms: 0,
        sites: []
      };
      byCustomer.set(ckey, cust);
    }
    const sname = (r.site_name as string | null) ?? null;
    let site = cust.sites.find((s) => s.siteName === sname);
    if (!site) {
      site = { siteName: sname, total: 0, online: 0, offline: 0, totalEnergyKwh: 0, openAlarms: 0, buildings: [] };
      cust.sites.push(site);
    }
    const bname = (r.project_name as string | null) ?? null;
    let bld = site.buildings.find((b) => b.buildingName === bname);
    if (!bld) {
      bld = { buildingName: bname, total: 0, online: 0, offline: 0, totalEnergyKwh: 0, openAlarms: 0, units: [] };
      site.buildings.push(bld);
    }
    const total = int(r.total);
    const online = int(r.online);
    const leaf: HierarchyUnitNode = {
      unitLabel: (r.unit_label as string | null) ?? null,
      total,
      online,
      offline: Math.max(total - online, 0),
      totalEnergyKwh: num(r.total_energy_kwh) ?? 0,
      openAlarms: int(r.open_alarms)
    };
    bld.units.push(leaf);
    addStats(bld, leaf);
    addStats(site, leaf);
    addStats(cust, leaf);
  }
  return Array.from(byCustomer.values());
};

export interface ModelOverviewRow {
  /** device model (e.g. ADL200, ADL300); null bucket = model not yet derived. */
  model: string | null;
  total: number;
}

/**
 * Fleet device-type breakdown (count per model, all registry states) for the device-mix
 * donut. Single grouped query so it scales with the fleet, not the browser.
 */
export const getModelOverview = async (pool: Pool): Promise<ModelOverviewRow[]> => {
  const res = await pool.query(
    `SELECT model, COUNT(*) AS total
     FROM devices
     GROUP BY model
     ORDER BY COUNT(*) DESC, model NULLS LAST`
  );
  return res.rows.map((r) => ({
    model: (r.model as string | null) ?? null,
    total: int(r.total)
  }));
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
  /** Filter by project_name (building). Use "__none__" for devices with no building assigned. */
  project?: string | null;
  /** Filter by site_name (yerleşke). Use "__none__" for devices with no site assigned. */
  site?: string | null;
  /** Filter by owning customer id (used by the customer-scoped API). */
  customerId?: string | null;
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
  if (filter.project) {
    if (filter.project === "__none__") {
      where.push(`(d.project_name IS NULL OR d.project_name = '')`);
    } else {
      params.push(filter.project);
      where.push(`d.project_name = $${params.length}`);
    }
  }
  if (filter.site) {
    if (filter.site === "__none__") {
      where.push(`(d.site_name IS NULL OR d.site_name = '')`);
    } else {
      params.push(filter.site);
      where.push(`d.site_name = $${params.length}`);
    }
  }
  if (filter.customerId) {
    params.push(filter.customerId);
    where.push(`d.customer_id = $${params.length}`);
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
