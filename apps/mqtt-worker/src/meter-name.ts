/**
 * Outbound `meterName` builder for FORCESWITCH (and other operate) payloads.
 *
 * Format: "<projectName>-<model>-<sn>" (e.g. "SavasEvi-ADL300-25033106593193").
 * Empty/blank project or model parts collapse to the placeholder "NA" so the field is always
 * well-formed (the serial number is always present). Applied identically to open and close.
 */
export const METER_NAME_PLACEHOLDER = "NA";

const part = (value: string | null | undefined): string => {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : METER_NAME_PLACEHOLDER;
};

export const buildMeterName = (
  projectName: string | null | undefined,
  model: string | null | undefined,
  sn: string
): string => `${part(projectName)}-${part(model)}-${sn}`;
