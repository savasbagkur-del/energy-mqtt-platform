/**
 * Effective ordering time for latest_state: payload ISO timestamp if parseable, else fallback.
 */
export const resolveEffectiveMessageTimestamp = (
  timestampIso: string | null,
  receivedAt: Date
): Date => {
  if (!timestampIso || timestampIso.trim().length === 0) {
    return receivedAt;
  }
  const parsed = Date.parse(timestampIso);
  if (Number.isNaN(parsed)) {
    return receivedAt;
  }
  return new Date(parsed);
};
