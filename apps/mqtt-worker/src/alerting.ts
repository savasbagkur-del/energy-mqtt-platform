/**
 * Best-effort fault/alarm notifier. POSTs a JSON payload to a generic webhook.
 * Design rules (resilient "never give up" worker):
 *  - Never throws and never blocks the caller (fire-and-forget with timeout).
 *  - Throttles repeats per alert key so a storm cannot flood the webhook.
 *  - When no webhook URL is configured, it degrades to structured logging.
 */

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  /** Stable machine type, e.g. "device_online_but_no_ack_fault". */
  type: string;
  severity: AlertSeverity;
  message: string;
  /** Optional device serial; used (with type) as the throttle key. */
  sn?: string;
  /** Extra structured context attached to the payload. */
  fields?: Record<string, unknown>;
}

export interface AlerterStats {
  sent: number;
  failed: number;
  throttled: number;
}

export interface Alerter {
  notify: (alert: Alert) => void;
  stats: () => AlerterStats;
}

export interface AlerterOptions {
  webhookUrl: string | null;
  minIntervalSec: number;
  timeoutMs: number;
  source: string;
  log: {
    info: (msg: string, f?: Record<string, unknown>) => void;
    warn: (msg: string, f?: Record<string, unknown>) => void;
    error: (msg: string, f?: Record<string, unknown>) => void;
  };
}

export const createAlerter = (opts: AlerterOptions): Alerter => {
  const stats: AlerterStats = { sent: 0, failed: 0, throttled: 0 };
  const lastSentAtByKey = new Map<string, number>();
  const minIntervalMs = Math.max(0, opts.minIntervalSec * 1000);

  const post = async (alert: Alert): Promise<void> => {
    if (!opts.webhookUrl) {
      // Alerting disabled: surface the alert in logs so it is never silently lost.
      opts.log.warn("alert_logged_only", { type: alert.type, severity: alert.severity, sn: alert.sn, message: alert.message, ...alert.fields });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: opts.source,
          type: alert.type,
          severity: alert.severity,
          message: alert.message,
          sn: alert.sn ?? null,
          fields: alert.fields ?? {},
          timestamp: new Date().toISOString()
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        stats.failed += 1;
        opts.log.error("alert_webhook_non_2xx", { type: alert.type, status: res.status });
        return;
      }
      stats.sent += 1;
      opts.log.info("alert_sent", { type: alert.type, severity: alert.severity, sn: alert.sn });
    } catch (error) {
      stats.failed += 1;
      opts.log.error("alert_webhook_failed", { type: alert.type, message: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    notify(alert: Alert): void {
      const key = `${alert.type}:${alert.sn ?? "-"}`;
      const now = Date.now();
      const last = lastSentAtByKey.get(key);
      if (last !== undefined && now - last < minIntervalMs) {
        stats.throttled += 1;
        return;
      }
      lastSentAtByKey.set(key, now);
      // Fire-and-forget: the caller must never wait on (or be broken by) the webhook.
      void post(alert);
    },
    stats() {
      return { ...stats };
    }
  };
};
