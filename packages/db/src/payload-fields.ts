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

/** Reads field from root or nested `data` object (same convention as mqtt normalize). */
export const resolvePayloadString = (
  root: Record<string, unknown> | null,
  field: string
): string | null => {
  if (!root) {
    return null;
  }
  const direct = asString(root[field]);
  if (direct !== null) {
    return direct;
  }
  const data = asRecord(root.data);
  if (data) {
    return asString(data[field]);
  }
  return null;
};

/** Network may be object or string in device payloads. */
export const resolvePayloadNetwork = (
  root: Record<string, unknown> | null
): unknown => {
  if (!root) {
    return null;
  }
  const direct = root.network;
  if (direct !== undefined && direct !== null) {
    return direct;
  }
  const data = asRecord(root.data);
  if (data && "network" in data) {
    return data.network;
  }
  return null;
};

export interface DeviceMetadataFields {
  devname: string | null;
  softcode: string | null;
  softversion: string | null;
  network: unknown;
}

export const extractDeviceMetadata = (
  payloadJson: Record<string, unknown> | null
): DeviceMetadataFields => ({
  devname: resolvePayloadString(payloadJson, "devname"),
  softcode: resolvePayloadString(payloadJson, "softcode"),
  softversion: resolvePayloadString(payloadJson, "softversion"),
  network: resolvePayloadNetwork(payloadJson)
});
