/**
 * Switch-state decode for meters that do NOT report `SwitchSta` directly.
 *
 * Empirically validated on Acrel prepaid meters via live field test (SN 24042809890002):
 *   relay OFF -> AdfState1 ≈ 488   (0x01E8, bit 15 clear), PRESTATE = 699
 *   relay ON  -> AdfState1 ≈ 57583 (0xE0EF, bit 15 set),   PRESTATE = 570
 * (Transitional reads — OFF:232 / ON:57839 — agree on bit 15.)
 *
 * Bit 15 (0x8000) of AdfState1 reflects the relay coil state. This is a device-family heuristic;
 * Faz C will make the source field / bit per-device configurable.
 */
export const ADF_STATE1_SWITCH_BIT = 0x8000;

const toNum = (v: unknown): number | null => {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (t.length === 0) {
      return null;
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Relay state from AdfState1 bit 15. Returns 1 (on) / 0 (off) / null (unknown/absent). */
export const decodeSwitchFromAdfState1 = (adfState1: unknown): 0 | 1 | null => {
  const n = toNum(adfState1);
  if (n === null) {
    return null;
  }
  return (Math.trunc(n) & ADF_STATE1_SWITCH_BIT) !== 0 ? 1 : 0;
};

/**
 * Resolve effective switch state. `SwitchSta` always wins when it is a clean 0/1; otherwise fall
 * back to the AdfState1 bit-15 decode (only when `allowAdfFallback`).
 */
export const resolveSwitchState = (
  switchSta: unknown,
  adfState1: unknown,
  allowAdfFallback = true
): 0 | 1 | null => {
  const s = toNum(switchSta);
  if (s === 0 || s === 1) {
    return s;
  }
  if (!allowAdfFallback) {
    return null;
  }
  return decodeSwitchFromAdfState1(adfState1);
};
