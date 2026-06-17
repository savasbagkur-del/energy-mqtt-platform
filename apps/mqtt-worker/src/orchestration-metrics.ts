/**
 * In-process observability for command orchestration (rates, latency percentiles).
 * For multi-replica deployments, aggregate these logs externally.
 */

const MAX_SAMPLES = 2000;

const ackLatencyMs: number[] = [];
const verifyLatencyMs: number[] = [];

const counters = {
  ackInboundAccepted: 0,
  ackTimeoutDelivery: 0,
  ackTimeoutRetryScheduled: 0,
  verifySuccess: 0,
  verifyMismatchOrFail: 0,
  lateConfirmation: 0,
  refreshVerifyTimeout: 0,
  refreshVerifyRecoveredFromEvidence: 0,
  parentSwitchVerifyTimeout: 0
};

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) {
    return null;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
};

const pushSample = (arr: number[], v: number): void => {
  if (!Number.isFinite(v) || v < 0) {
    return;
  }
  arr.push(v);
  if (arr.length > MAX_SAMPLES) {
    arr.splice(0, arr.length - MAX_SAMPLES);
  }
};

export const orchestrationMetrics = {
  increment(metric: keyof typeof counters): void {
    counters[metric] += 1;
  },

  recordAckLatencyMs(ms: number | null): void {
    if (ms == null || !Number.isFinite(ms)) {
      return;
    }
    pushSample(ackLatencyMs, ms);
  },

  recordVerifyLatencyMs(ms: number | null): void {
    if (ms == null || !Number.isFinite(ms)) {
      return;
    }
    pushSample(verifyLatencyMs, ms);
  },

  emitSnapshot(): void {
    const a = [...ackLatencyMs].sort((x, y) => x - y);
    const v = [...verifyLatencyMs].sort((x, y) => x - y);
    const ackAttempts = counters.ackInboundAccepted + counters.ackTimeoutRetryScheduled;
    const verifyTotal = counters.verifySuccess + counters.verifyMismatchOrFail;
    console.log("[mqtt-worker][command] orchestration_metrics_snapshot", {
      counters,
      ackSuccessRateApprox:
        ackAttempts > 0 ? counters.ackInboundAccepted / (counters.ackInboundAccepted + counters.ackTimeoutDelivery) : null,
      verifySuccessRateApprox:
        verifyTotal > 0 ? counters.verifySuccess / verifyTotal : null,
      lateConfirmationCount: counters.lateConfirmation,
      ackLatencyMs: {
        p50: percentile(a, 50),
        p95: percentile(a, 95),
        sampleCount: a.length
      },
      verifyLatencyMs: {
        p50: percentile(v, 50),
        p95: percentile(v, 95),
        sampleCount: v.length
      }
    });
  }
};
