import { randomInt } from "node:crypto";

/**
 * Digits-only operate msgid for MQTT payloads. Avoids UUIDs that some firmware
 * corrupts when echoing on indicate/dev ACKs.
 * ~19 decimal digits: epoch ms + 6 random digits (unique enough per ms).
 */
export const generateCommandMsgid = (): string => {
  const t = Date.now();
  const r = randomInt(0, 1_000_000);
  return `${t}${String(r).padStart(6, "0")}`;
};
