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

/**
 * Reads a field from the root or any of the nested envelope objects devices use:
 * `payload` (Acrel login: {"method":"login","payload":{"devname":...}}) or `data`.
 */
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
  for (const nestedKey of ["payload", "data"]) {
    const nested = asRecord(root[nestedKey]);
    if (nested) {
      const value = asString(nested[field]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
};

/** Network may be object, string or number in device payloads (root, `payload` or `data`). */
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
  for (const nestedKey of ["payload", "data"]) {
    const nested = asRecord(root[nestedKey]);
    if (nested && "network" in nested && nested.network !== undefined && nested.network !== null) {
      return nested.network;
    }
  }
  return null;
};

export interface DeviceMetadataFields {
  devname: string | null;
  softcode: string | null;
  softversion: string | null;
  network: unknown;
  model: string | null;
}

/**
 * Classify a device hardware model from its firmware-reported devname.
 * Takes the model family prefix before the first dash and upper-cases it,
 * e.g. "ADL300-EY-IOT" -> "ADL300", "DDSY1352-IOT" -> "DDSY1352".
 * Used as a label and to derive the phase count (ADL3xx are three-phase).
 */
export const resolveDeviceModel = (
  devname: string | null | undefined
): string | null => {
  if (typeof devname !== "string") {
    return null;
  }
  const prefix = devname.trim().split("-")[0]?.trim().toUpperCase() ?? "";
  return prefix.length > 0 ? prefix : null;
};

export const extractDeviceMetadata = (
  payloadJson: Record<string, unknown> | null
): DeviceMetadataFields => {
  const devname = resolvePayloadString(payloadJson, "devname");
  // An explicit `model` field (e.g. ME372 optical bridge) wins; otherwise derive from devname.
  const explicitModel = resolvePayloadString(payloadJson, "model");
  return {
    devname,
    softcode: resolvePayloadString(payloadJson, "softcode"),
    softversion: resolvePayloadString(payloadJson, "softversion"),
    network: resolvePayloadNetwork(payloadJson),
    model: explicitModel ?? resolveDeviceModel(devname)
  };
};
