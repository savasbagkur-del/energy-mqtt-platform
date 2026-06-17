import type { NormalizedIncomingMessage } from "@communication/contracts";
import { extractOperateRes, extractReportedSummary } from "./acrel.js";
import { parseTopic } from "./topic.js";

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
};

const resolveField = (
  root: Record<string, unknown> | null,
  fieldName: string
): string | null => {
  if (!root) {
    return null;
  }

  const direct = asString(root[fieldName]);
  if (direct !== null) {
    return direct;
  }

  const data = asRecord(root.data);
  if (data) {
    return asString(data[fieldName]);
  }

  return null;
};

const stripControlChars = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/**
 * Normalize msgid from device (string or numeric JSON) for correlation.
 * Protocol msgid: some devices use msgId / MsgID instead of msgid.
 */
const resolveProtocolMsgid = (root: Record<string, unknown> | null): string | null => {
  if (!root) {
    return null;
  }
  for (const key of ["msgid", "msgId", "MsgID", "MsgId"] as const) {
    const direct = root[key];
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return stripControlChars(String(direct)).trim();
    }
    if (typeof direct === "bigint") {
      return direct.toString();
    }
    const v = resolveField(root, key);
    if (v !== null) {
      return stripControlChars(v).trim();
    }
  }
  return null;
};

export const normalizeIncomingMessage = (
  topic: string,
  payload: Buffer
): NormalizedIncomingMessage => {
  const payloadText = payload.toString("utf8");
  let payloadJson: Record<string, unknown> | null = null;
  let payloadParseError: string | null = null;

  try {
    payloadJson = asRecord(JSON.parse(payloadText));
    if (payloadJson === null) {
      payloadParseError = "payload is not a JSON object";
    }
  } catch (error) {
    payloadParseError =
      error instanceof Error ? error.message : "unknown JSON parse error";
  }

  const reportedSummary = extractReportedSummary(payloadJson);
  const operateRes = extractOperateRes(payloadJson);

  return {
    topic: parseTopic(topic),
    sn: resolveField(payloadJson, "sn"),
    method: resolveField(payloadJson, "method"),
    msgid: resolveProtocolMsgid(payloadJson),
    timestamp: resolveField(payloadJson, "timestamp"),
    reportedSummary,
    operateRes,
    payloadJson,
    payloadText,
    payloadParseError
  };
};
