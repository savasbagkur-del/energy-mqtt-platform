import type { NormalizedIncomingMessage } from "@communication/contracts";
import { extractDeviceMetadata } from "./payload-fields.js";

/**
 * Compact Acrel-like summary for API and `latest_state.last_summary`.
 */
export const buildLastSummaryJson = (
  normalized: NormalizedIncomingMessage
): Record<string, unknown> | null => {
  const method = normalized.method;
  if (!method) {
    return null;
  }

  const base: Record<string, unknown> = { method };
  if (normalized.msgid) {
    base.msgid = normalized.msgid;
  }
  if (normalized.timestamp) {
    base.timestamp = normalized.timestamp;
  }

  if (method === "update" && normalized.reportedSummary) {
    const keys = Object.keys(normalized.reportedSummary);
    if (keys.length > 0) {
      return { ...base, reported: normalized.reportedSummary };
    }
  }

  if (method === "operate" && normalized.operateRes != null) {
    return { ...base, res: normalized.operateRes };
  }

  if (method === "login" && normalized.payloadJson) {
    const meta = extractDeviceMetadata(normalized.payloadJson);
    return {
      ...base,
      login: {
        devname: meta.devname,
        softcode: meta.softcode,
        softversion: meta.softversion,
        network: meta.network
      }
    };
  }

  return base;
};
