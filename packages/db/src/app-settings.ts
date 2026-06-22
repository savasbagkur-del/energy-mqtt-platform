import type { Pool } from "pg";

/**
 * Server-side key/value settings shared across all browsers (unlike localStorage). Currently backs
 * the billing chargeback config so monthly cost / margin / currency stay identical on every device.
 */

/** Which figure drives chargeback: the manual estimate, AWS month-to-date actual, or the month-end forecast. */
export type CostBasis = "manual" | "actual" | "forecast";

export interface BillingConfig {
  monthlyCost: number;
  marginPct: number;
  currency: string;
  /** Cost figure used as the allocation base. 'manual' = monthlyCost field above. */
  costBasis: CostBasis;
  /** Rolling window (days) over which per-device data volume is measured for usage-weighted allocation. */
  usageWindowDays: number;
}

/** Loosely-typed input (any field may be absent/undefined); sanitized to a full BillingConfig. */
export interface BillingConfigInput {
  monthlyCost?: number | undefined;
  marginPct?: number | undefined;
  currency?: string | undefined;
  costBasis?: string | undefined;
  usageWindowDays?: number | undefined;
}

const BILLING_KEY = "billing";
const ALLOWED_CURRENCIES = ["USD", "EUR", "TRY"];
const ALLOWED_BASIS: CostBasis[] = ["manual", "actual", "forecast"];
const DEFAULT_BILLING: BillingConfig = {
  monthlyCost: 92,
  marginPct: 30,
  currency: "USD",
  costBasis: "manual",
  usageWindowDays: 7
};

const sanitize = (input: BillingConfigInput | null | undefined): BillingConfig => {
  const v = input ?? {};
  const cost = Number(v.monthlyCost);
  const margin = Number(v.marginPct);
  const win = Number(v.usageWindowDays);
  return {
    monthlyCost: Number.isFinite(cost) && cost >= 0 ? cost : DEFAULT_BILLING.monthlyCost,
    marginPct: Number.isFinite(margin) && margin >= 0 ? margin : DEFAULT_BILLING.marginPct,
    currency: typeof v.currency === "string" && ALLOWED_CURRENCIES.includes(v.currency) ? v.currency : DEFAULT_BILLING.currency,
    costBasis: typeof v.costBasis === "string" && (ALLOWED_BASIS as string[]).includes(v.costBasis)
      ? (v.costBasis as CostBasis) : DEFAULT_BILLING.costBasis,
    usageWindowDays: Number.isFinite(win) && win >= 1 && win <= 90 ? Math.round(win) : DEFAULT_BILLING.usageWindowDays
  };
};

export const getBillingConfig = async (pool: Pool): Promise<BillingConfig> => {
  const res = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [BILLING_KEY]);
  const raw = res.rows[0]?.value;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_BILLING };
  return sanitize(raw as BillingConfigInput);
};

export const setBillingConfig = async (pool: Pool, input: BillingConfigInput): Promise<BillingConfig> => {
  const clean = sanitize(input);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [BILLING_KEY, JSON.stringify(clean)]
  );
  return clean;
};
