import type { Pool } from "pg";
import { getDeviceBySn } from "./devices.js";
import { upsertDesiredSwitch } from "./desired-state.js";

/** Sentinel: cutoff_balance_kwh at or below this disables automatic disconnect. */
export const PREPAID_CUTOFF_DISABLED = -9999;

export type PrepaidTopupSource = "panel" | "api" | "import";

export interface DevicePrepaidSettingsRow {
  sn: string;
  baseline_epi_kwh: number;
  cutoff_balance_kwh: number;
  auto_cutoff_enabled: boolean;
  updated_at: string;
}

export interface PrepaidTopupRow {
  id: string;
  sn: string;
  customer_id: string | null;
  amount_kwh: number;
  amount_money: number | null;
  source: PrepaidTopupSource;
  ref: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PrepaidSummary {
  sn: string;
  meter_usage: string;
  prepaid_active: boolean;
  baseline_epi_kwh: number;
  current_epi_kwh: number | null;
  total_consumption_kwh: number;
  total_topup_kwh: number;
  balance_kwh: number;
  meter_balance_kwh: number | null;
  cutoff_balance_kwh: number;
  auto_cutoff_enabled: boolean;
  cutoff_disabled: boolean;
  switch_state: number | null;
}

export interface PrepaidConsumptionPoint {
  bucket: string;
  consumption_kwh: number;
  epi_end_kwh: number | null;
  samples: number;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Ensure settings row exists; baseline = current EPI when first created. */
export const ensureDevicePrepaidSettings = async (pool: Pool, sn: string): Promise<DevicePrepaidSettingsRow> => {
  const existing = await pool.query<DevicePrepaidSettingsRow>(
    `SELECT sn, baseline_epi_kwh::float8 AS baseline_epi_kwh,
            cutoff_balance_kwh::float8 AS cutoff_balance_kwh,
            auto_cutoff_enabled, updated_at::text AS updated_at
     FROM device_prepaid_settings WHERE sn = $1`,
    [sn]
  );
  if (existing.rows[0]) {
    return {
      ...existing.rows[0],
      baseline_epi_kwh: Number(existing.rows[0].baseline_epi_kwh),
      cutoff_balance_kwh: Number(existing.rows[0].cutoff_balance_kwh)
    };
  }

  const epiRes = await pool.query<{ epi: string | null }>(
    `SELECT energy_import_kwh::text AS epi FROM device_latest_state WHERE sn = $1`,
    [sn]
  );
  const baseline = num(epiRes.rows[0]?.epi) ?? 0;

  const ins = await pool.query<DevicePrepaidSettingsRow>(
    `INSERT INTO device_prepaid_settings (sn, baseline_epi_kwh)
     VALUES ($1, $2)
     ON CONFLICT (sn) DO NOTHING
     RETURNING sn, baseline_epi_kwh::float8 AS baseline_epi_kwh,
               cutoff_balance_kwh::float8 AS cutoff_balance_kwh,
               auto_cutoff_enabled, updated_at::text AS updated_at`,
    [sn, baseline]
  );
  if (ins.rows[0]) {
    return {
      ...ins.rows[0],
      baseline_epi_kwh: Number(ins.rows[0].baseline_epi_kwh),
      cutoff_balance_kwh: Number(ins.rows[0].cutoff_balance_kwh)
    };
  }
  const again = await pool.query<DevicePrepaidSettingsRow>(
    `SELECT sn, baseline_epi_kwh::float8 AS baseline_epi_kwh,
            cutoff_balance_kwh::float8 AS cutoff_balance_kwh,
            auto_cutoff_enabled, updated_at::text AS updated_at
     FROM device_prepaid_settings WHERE sn = $1`,
    [sn]
  );
  const row = again.rows[0]!;
  return {
    ...row,
    baseline_epi_kwh: Number(row.baseline_epi_kwh),
    cutoff_balance_kwh: Number(row.cutoff_balance_kwh)
  };
};

export const updateDevicePrepaidSettings = async (
  pool: Pool,
  sn: string,
  patch: {
    baselineEpiKwh?: number;
    cutoffBalanceKwh?: number;
    autoCutoffEnabled?: boolean;
  }
): Promise<DevicePrepaidSettingsRow | null> => {
  await ensureDevicePrepaidSettings(pool, sn);
  const res = await pool.query<DevicePrepaidSettingsRow>(
    `UPDATE device_prepaid_settings SET
       baseline_epi_kwh = COALESCE($2, baseline_epi_kwh),
       cutoff_balance_kwh = COALESCE($3, cutoff_balance_kwh),
       auto_cutoff_enabled = COALESCE($4, auto_cutoff_enabled),
       updated_at = NOW()
     WHERE sn = $1
     RETURNING sn, baseline_epi_kwh::float8 AS baseline_epi_kwh,
               cutoff_balance_kwh::float8 AS cutoff_balance_kwh,
               auto_cutoff_enabled, updated_at::text AS updated_at`,
    [
      sn,
      patch.baselineEpiKwh ?? null,
      patch.cutoffBalanceKwh ?? null,
      patch.autoCutoffEnabled ?? null
    ]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    baseline_epi_kwh: Number(row.baseline_epi_kwh),
    cutoff_balance_kwh: Number(row.cutoff_balance_kwh)
  };
};

export const createPrepaidTopup = async (
  pool: Pool,
  input: {
    sn: string;
    amountKwh: number;
    amountMoney?: number | null;
    source: PrepaidTopupSource;
    ref?: string | null;
    note?: string | null;
    createdBy?: string | null;
    customerId?: string | null;
  }
): Promise<PrepaidTopupRow> => {
  if (!Number.isFinite(input.amountKwh) || input.amountKwh <= 0) {
    throw new Error("invalid_topup_amount");
  }
  await ensureDevicePrepaidSettings(pool, input.sn);

  let customerId = input.customerId ?? null;
  if (!customerId) {
    const cidRes = await pool.query<{ customer_id: string | null }>(
      `SELECT customer_id::text AS customer_id FROM devices WHERE sn = $1`,
      [input.sn]
    );
    customerId = cidRes.rows[0]?.customer_id ?? null;
  }

  const res = await pool.query<PrepaidTopupRow>(
    `INSERT INTO prepaid_topups (sn, customer_id, amount_kwh, amount_money, source, ref, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id::text AS id, sn, customer_id::text AS customer_id,
               amount_kwh::float8 AS amount_kwh, amount_money::float8 AS amount_money,
               source, ref, note, created_by, created_at::text AS created_at`,
    [
      input.sn,
      customerId,
      input.amountKwh,
      input.amountMoney ?? null,
      input.source,
      input.ref ?? null,
      input.note ?? null,
      input.createdBy ?? null
    ]
  );
  const row = res.rows[0]!;
  return {
    ...row,
    amount_kwh: Number(row.amount_kwh),
    amount_money: row.amount_money != null ? Number(row.amount_money) : null
  };
};

export const listPrepaidTopups = async (
  pool: Pool,
  sn: string,
  limit = 50
): Promise<PrepaidTopupRow[]> => {
  const lim = Math.max(1, Math.min(200, Math.floor(limit)));
  const res = await pool.query<PrepaidTopupRow>(
    `SELECT id::text AS id, sn, customer_id::text AS customer_id,
            amount_kwh::float8 AS amount_kwh, amount_money::float8 AS amount_money,
            source, ref, note, created_by, created_at::text AS created_at
     FROM prepaid_topups
     WHERE sn = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sn, lim]
  );
  return res.rows.map((r) => ({
    ...r,
    amount_kwh: Number(r.amount_kwh),
    amount_money: r.amount_money != null ? Number(r.amount_money) : null
  }));
};

const buildPrepaidSummary = (
  sn: string,
  settings: DevicePrepaidSettingsRow,
  totalTopup: number,
  currentEpi: number | null,
  meterBalance: number | null,
  switchState: number | null
): PrepaidSummary => {
  const consumption =
    currentEpi != null ? Math.max(0, round3(currentEpi - settings.baseline_epi_kwh)) : 0;
  return {
    sn,
    meter_usage: "prepaid",
    prepaid_active: true,
    baseline_epi_kwh: settings.baseline_epi_kwh,
    current_epi_kwh: currentEpi,
    total_consumption_kwh: consumption,
    total_topup_kwh: round3(totalTopup),
    balance_kwh: round3(totalTopup - consumption),
    meter_balance_kwh: meterBalance,
    cutoff_balance_kwh: settings.cutoff_balance_kwh,
    auto_cutoff_enabled: settings.auto_cutoff_enabled,
    cutoff_disabled: settings.cutoff_balance_kwh <= PREPAID_CUTOFF_DISABLED + 1,
    switch_state: switchState
  };
};

export const getPrepaidSummary = async (pool: Pool, sn: string): Promise<PrepaidSummary | null> => {
  const devRes = await pool.query<{ meter_usage: string }>(
    `SELECT meter_usage FROM devices WHERE sn = $1`,
    [sn]
  );
  if (devRes.rows[0]?.meter_usage !== "prepaid") {
    return null;
  }

  const settings = await ensureDevicePrepaidSettings(pool, sn);
  const aggRes = await pool.query<{
    topup: string;
    epi: string | null;
    meter_balance: string | null;
    sw: number | null;
  }>(
    `SELECT
       COALESCE((SELECT SUM(amount_kwh) FROM prepaid_topups WHERE sn = $1), 0)::text AS topup,
       ls.energy_import_kwh::text AS epi,
       ls.balance::text AS meter_balance,
       ls.switch_state AS sw
     FROM device_latest_state ls
     WHERE ls.sn = $1`,
    [sn]
  );
  const agg = aggRes.rows[0];
  return buildPrepaidSummary(
    sn,
    settings,
    num(agg?.topup) ?? 0,
    num(agg?.epi),
    num(agg?.meter_balance),
    agg?.sw ?? null
  );
};

/** Batch prepaid summaries for fleet / getMeterList (avoids N+1). */
export const getPrepaidSummariesForSns = async (
  pool: Pool,
  sns: string[]
): Promise<Map<string, PrepaidSummary>> => {
  const out = new Map<string, PrepaidSummary>();
  if (sns.length === 0) return out;

  const res = await pool.query<{
    sn: string;
    baseline_epi_kwh: string;
    cutoff_balance_kwh: string;
    auto_cutoff_enabled: boolean;
    topup: string;
    epi: string | null;
    meter_balance: string | null;
    sw: number | null;
  }>(
    `SELECT
       d.sn,
       COALESCE(s.baseline_epi_kwh, 0)::text AS baseline_epi_kwh,
       COALESCE(s.cutoff_balance_kwh, 0)::text AS cutoff_balance_kwh,
       COALESCE(s.auto_cutoff_enabled, FALSE) AS auto_cutoff_enabled,
       COALESCE((SELECT SUM(amount_kwh) FROM prepaid_topups t WHERE t.sn = d.sn), 0)::text AS topup,
       ls.energy_import_kwh::text AS epi,
       ls.balance::text AS meter_balance,
       ls.switch_state AS sw
     FROM devices d
     LEFT JOIN device_prepaid_settings s ON s.sn = d.sn
     LEFT JOIN device_latest_state ls ON ls.sn = d.sn
     WHERE d.sn = ANY($1::text[]) AND d.meter_usage = 'prepaid'`,
    [sns]
  );

  for (const row of res.rows) {
    const settings: DevicePrepaidSettingsRow = {
      sn: row.sn,
      baseline_epi_kwh: Number(row.baseline_epi_kwh),
      cutoff_balance_kwh: Number(row.cutoff_balance_kwh),
      auto_cutoff_enabled: row.auto_cutoff_enabled,
      updated_at: ""
    };
    out.set(
      row.sn,
      buildPrepaidSummary(
        row.sn,
        settings,
        num(row.topup) ?? 0,
        num(row.epi),
        num(row.meter_balance),
        row.sw
      )
    );
  }
  return out;
};

const periodTrunc = (period: "day" | "week" | "month"): string => {
  if (period === "week") return "week";
  if (period === "month") return "month";
  return "day";
};

const periodLimitDefault = (period: "day" | "week" | "month"): number => {
  if (period === "week") return 26;
  if (period === "month") return 24;
  return 60;
};

const periodLookbackDays = (period: "day" | "week" | "month", limit: number): number => {
  if (period === "month") return limit * 31 + 31;
  if (period === "week") return limit * 7 + 14;
  return limit + 2;
};

/** EPI delta per calendar bucket (day / ISO week / month). */
export const getPrepaidConsumptionSeries = async (
  pool: Pool,
  sn: string,
  period: "day" | "week" | "month",
  limit?: number
): Promise<PrepaidConsumptionPoint[]> => {
  const lim = Math.max(1, Math.min(120, limit ?? periodLimitDefault(period)));
  const trunc = periodTrunc(period);
  const lookbackDays = periodLookbackDays(period, lim);

  const res = await pool.query<{
    bucket: Date;
    epi_max: string | null;
    samples: string;
    consumption_kwh: string | null;
  }>(
    `WITH buckets AS (
       SELECT
         date_trunc('${trunc}', observed_at AT TIME ZONE 'UTC') AS bucket,
         MAX(energy_import_kwh) AS epi_max,
         COUNT(*) AS samples
       FROM telemetry_samples
       WHERE sn = $1
         AND observed_at >= NOW() - ($2 || ' days')::interval
         AND energy_import_kwh IS NOT NULL
       GROUP BY 1
     ),
     with_delta AS (
       SELECT
         bucket,
         epi_max,
         samples,
         epi_max - LAG(epi_max) OVER (ORDER BY bucket) AS consumption_kwh
       FROM buckets
     )
     SELECT bucket, epi_max::text, samples::text, consumption_kwh::text
     FROM with_delta
     WHERE consumption_kwh IS NOT NULL
     ORDER BY bucket DESC
     LIMIT $3`,
    [sn, String(lookbackDays), lim]
  );

  return res.rows
    .map((r) => ({
      bucket: new Date(r.bucket).toISOString(),
      consumption_kwh: round3(Number(r.consumption_kwh ?? 0)),
      epi_end_kwh: num(r.epi_max),
      samples: Number(r.samples)
    }))
    .reverse();
};

/** When balance <= cutoff and auto enabled, queue switch-off via desired state. */
export const evaluatePrepaidAutoCutoff = async (pool: Pool, sn: string): Promise<boolean> => {
  const summary = await getPrepaidSummary(pool, sn);
  if (!summary) return false;
  if (!summary.auto_cutoff_enabled) return false;
  if (summary.cutoff_disabled) return false;
  if (summary.balance_kwh > summary.cutoff_balance_kwh) return false;
  if (summary.switch_state !== 1) return false;

  const dev = await getDeviceBySn(pool, sn);
  if (!dev) return false;

  await upsertDesiredSwitch(pool, {
    sn,
    productKey: dev.product_key ?? null,
    value: 0,
    setBy: "prepaid_auto_cutoff"
  });
  return true;
};

export const addPrepaidTopupByRoom = async (
  pool: Pool,
  customerId: string,
  roomNo: string,
  input: {
    amountKwh: number;
    amountMoney?: number | null;
    source: PrepaidTopupSource;
    ref?: string | null;
    note?: string | null;
    createdBy?: string | null;
  }
): Promise<{ topup: PrepaidTopupRow; summary: PrepaidSummary } | null> => {
  const snRes = await pool.query<{ sn: string }>(
    `SELECT sn FROM devices
     WHERE customer_id = $1 AND (unit_no = $2 OR label = $2)
     ORDER BY registered_at ASC NULLS LAST, sn ASC
     LIMIT 2`,
    [customerId, roomNo]
  );
  if (snRes.rows.length !== 1) return null;
  const sn = String(snRes.rows[0]!.sn);
  const topup = await createPrepaidTopup(pool, {
    sn,
    customerId,
    amountKwh: input.amountKwh,
    source: input.source,
    ...(input.amountMoney !== undefined ? { amountMoney: input.amountMoney } : {}),
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {})
  });
  const summary = (await getPrepaidSummary(pool, sn))!;
  return { topup, summary };
};
