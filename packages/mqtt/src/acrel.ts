const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const REPORTED_KEYS = [
  "state",
  "Ua",
  "Ia",
  "P",
  "PF",
  "EPI",
  "Balance",
  "SwitchSta"
] as const;

/**
 * Extracts Acrel-style `reported` snapshot fields when present (e.g. method `update`).
 */
export const extractReportedSummary = (
  payloadJson: Record<string, unknown> | null
): Record<string, unknown> | null => {
  if (!payloadJson) {
    return null;
  }
  const reported = asRecord(payloadJson.reported);
  if (!reported) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of REPORTED_KEYS) {
    if (key in reported) {
      out[key] = reported[key];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
};

/**
 * Operate / indicate ack `res` field (root).
 */
export const extractOperateRes = (
  payloadJson: Record<string, unknown> | null
): string | null => {
  if (!payloadJson) {
    return null;
  }
  const res = payloadJson.res;
  if (typeof res === "string" && res.length > 0) {
    return res;
  }
  if (typeof res === "number" || typeof res === "boolean") {
    return String(res);
  }
  return null;
};
