import type { NormalizedIncomingMessage } from "@communication/contracts";
import type { Pool } from "pg";
import { upsertDevice, type UpsertDeviceInput } from "./devices.js";
import { buildLastSummaryJson } from "./last-summary.js";
import { upsertLatestStateIfNewer, type UpsertLatestStateInput } from "./latest-state.js";
import { extractDeviceMetadata } from "./payload-fields.js";
import { resolveEffectiveMessageTimestamp } from "./timestamp.js";

export interface InboundDeviceResolution {
  sn: string;
  productKey: string | null;
}

export const resolveInboundDevice = (
  normalized: NormalizedIncomingMessage
): InboundDeviceResolution | null => {
  const sn = normalized.sn ?? normalized.topic.deviceId;
  if (!sn || sn.trim().length === 0) {
    return null;
  }
  const productKey = normalized.topic.deviceType;
  return { sn, productKey };
};

/**
 * After raw row insert: upsert device row and conditionally update latest_state.
 */
export interface ApplyInboundOptions {
  /** When true, unknown SNs are recorded as 'quarantined' (visible, not managed). */
  whitelistEnabled?: boolean;
}

export const applyInboundDeviceAndLatestState = async (
  pool: Pool,
  normalized: NormalizedIncomingMessage,
  receivedAt: Date,
  options: ApplyInboundOptions = {}
): Promise<void> => {
  const resolved = resolveInboundDevice(normalized);
  if (!resolved) {
    return;
  }

  const { sn, productKey } = resolved;
  const meta = extractDeviceMetadata(normalized.payloadJson);
  const isLogin = normalized.method === "login";
  const effectiveTs = resolveEffectiveMessageTimestamp(
    normalized.timestamp,
    receivedAt
  );

  const payloadForLatest: unknown =
    normalized.payloadJson ?? { raw: normalized.payloadText };

  const lastSummary = buildLastSummaryJson(normalized);

  const deviceInput: UpsertDeviceInput = {
    sn,
    productKey,
    lastSeenAt: receivedAt,
    lastMethod: normalized.method,
    devname: isLogin ? meta.devname : null,
    softcode: isLogin ? meta.softcode : null,
    softversion: isLogin ? meta.softversion : null,
    network: isLogin ? meta.network : null,
    whitelistEnabled: options.whitelistEnabled ?? false
  };

  const latestInput: UpsertLatestStateInput = {
    sn,
    productKey,
    lastMethod: normalized.method,
    lastMsgid: normalized.msgid,
    lastTimestamp: effectiveTs,
    lastTopic: normalized.topic.raw,
    lastPayload: payloadForLatest,
    lastSummary: lastSummary ?? null
  };

  await upsertDevice(pool, deviceInput);
  await upsertLatestStateIfNewer(pool, latestInput);
};
