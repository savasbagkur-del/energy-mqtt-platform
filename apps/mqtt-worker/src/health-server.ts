import http from "node:http";
import { orchestrationMetrics } from "./orchestration-metrics.js";

/** Minimal structural type so this module needs no direct `pg` dependency. */
interface QueryablePool {
  query: (sql: string) => Promise<unknown>;
}

/**
 * Lightweight HTTP server exposing worker liveness, readiness, and Prometheus
 * metrics. The worker is otherwise headless (no HTTP), so orchestrators and
 * scrapers need this probe target. No external deps: hand-rolled exposition.
 */

export interface WorkerLiveState {
  mqttConnected: boolean;
  inboundQueueDepth: number;
  inboundActive: number;
  /** epoch ms of the last completed publish loop, or null before first run. */
  lastPublishLoopAt: number | null;
  /** epoch ms of the last completed reconcile loop, or null. */
  lastReconcileLoopAt: number | null;
  /** Webhook alerter counters. */
  alertStats: { sent: number; failed: number; throttled: number };
}

export interface HealthServerOptions {
  port: number;
  pool: QueryablePool;
  getState: () => WorkerLiveState;
  /** Max staleness of the publish loop before /ready reports not_ready. */
  readyMaxLoopAgeSec: number;
  log: { info: (msg: string, f?: Record<string, unknown>) => void; error: (msg: string, f?: Record<string, unknown>) => void };
}

const startedAt = Date.now();

// Cache the DB ping so a burst of scrapes cannot stampede the pool.
let dbUp = false;
let lastDbPingAt = 0;
const DB_PING_TTL_MS = 3000;

const pingDb = async (pool: QueryablePool): Promise<boolean> => {
  const now = Date.now();
  if (now - lastDbPingAt < DB_PING_TTL_MS) {
    return dbUp;
  }
  lastDbPingAt = now;
  try {
    await pool.query("SELECT 1");
    dbUp = true;
  } catch {
    dbUp = false;
  }
  return dbUp;
};

const ageSec = (epochMs: number | null): number | null =>
  epochMs === null ? null : Math.max(0, (Date.now() - epochMs) / 1000);

const renderMetrics = (state: WorkerLiveState, dbHealthy: boolean): string => {
  const snap = orchestrationMetrics.snapshot();
  const uptimeSec = (Date.now() - startedAt) / 1000;
  const publishAge = ageSec(state.lastPublishLoopAt);
  const reconcileAge = ageSec(state.lastReconcileLoopAt);
  const lines: string[] = [];
  const g = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };
  const c = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  };

  g("worker_up", "Worker process is running.", 1);
  g("worker_uptime_seconds", "Seconds since worker start.", Math.round(uptimeSec));
  g("worker_mqtt_connected", "1 if MQTT client is connected.", state.mqttConnected ? 1 : 0);
  g("worker_db_up", "1 if the last DB ping succeeded.", dbHealthy ? 1 : 0);
  g("worker_inbound_queue_depth", "Inbound MQTT messages waiting to be processed.", state.inboundQueueDepth);
  g("worker_inbound_active", "Inbound MQTT messages currently being processed.", state.inboundActive);
  if (publishAge !== null) {
    g("worker_last_publish_loop_age_seconds", "Seconds since the last publish loop completed.", Number(publishAge.toFixed(1)));
  }
  if (reconcileAge !== null) {
    g("worker_last_reconcile_loop_age_seconds", "Seconds since the last reconcile loop completed.", Number(reconcileAge.toFixed(1)));
  }

  const ctr = snap.counters;
  c("worker_command_ack_inbound_accepted_total", "ACKs accepted.", ctr.ackInboundAccepted);
  c("worker_command_ack_timeout_delivery_total", "Delivery windows exhausted (final ACK failure).", ctr.ackTimeoutDelivery);
  c("worker_command_ack_timeout_retry_total", "ACK timeouts that scheduled a retry.", ctr.ackTimeoutRetryScheduled);
  c("worker_command_verify_success_total", "Verify successes.", ctr.verifySuccess);
  c("worker_command_verify_fail_total", "Verify mismatches/failures.", ctr.verifyMismatchOrFail);
  c("worker_command_late_confirmation_total", "Late telemetry confirmations after timeout.", ctr.lateConfirmation);
  c("worker_command_refresh_verify_timeout_total", "Refresh verify timeouts.", ctr.refreshVerifyTimeout);
  c("worker_command_refresh_verify_recovered_total", "Refresh verifies recovered from evidence.", ctr.refreshVerifyRecoveredFromEvidence);
  c("worker_command_parent_switch_verify_timeout_total", "Parent switch verify timeouts.", ctr.parentSwitchVerifyTimeout);
  c("worker_alerts_sent_total", "Fault/alarm notifications delivered to the webhook.", state.alertStats.sent);
  c("worker_alerts_failed_total", "Fault/alarm notifications that failed to deliver.", state.alertStats.failed);
  c("worker_alerts_throttled_total", "Fault/alarm notifications suppressed by throttle.", state.alertStats.throttled);

  const lat = (name: string, help: string, q: number, value: number | null): void => {
    if (value === null) {
      return;
    }
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}{quantile="${q}"} ${Math.round(value)}`);
  };
  lat("worker_command_ack_latency_ms", "ACK latency milliseconds.", 0.5, snap.ackLatencyMs.p50);
  lat("worker_command_ack_latency_ms", "ACK latency milliseconds.", 0.95, snap.ackLatencyMs.p95);
  lat("worker_command_verify_latency_ms", "Verify latency milliseconds.", 0.5, snap.verifyLatencyMs.p50);
  lat("worker_command_verify_latency_ms", "Verify latency milliseconds.", 0.95, snap.verifyLatencyMs.p95);

  return lines.join("\n") + "\n";
};

export const createWorkerHealthServer = (opts: HealthServerOptions): http.Server => {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    void (async () => {
      if (url === "/health" || url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "mqtt-worker", uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));
        return;
      }
      if (url === "/ready") {
        const state = opts.getState();
        const dbHealthy = await pingDb(opts.pool);
        const publishAge = ageSec(state.lastPublishLoopAt);
        const loopFresh = publishAge !== null && publishAge <= opts.readyMaxLoopAgeSec;
        const ready = dbHealthy && state.mqttConnected && loopFresh;
        res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({
          status: ready ? "ready" : "not_ready",
          service: "mqtt-worker",
          checks: { dbUp: dbHealthy, mqttConnected: state.mqttConnected, publishLoopFresh: loopFresh, publishLoopAgeSec: publishAge }
        }));
        return;
      }
      if (url === "/metrics") {
        const state = opts.getState();
        const dbHealthy = await pingDb(opts.pool);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(renderMetrics(state, dbHealthy));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    })().catch((error: unknown) => {
      opts.log.error("health_server_handler_failed", { message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });

  server.on("error", (error) => {
    opts.log.error("health_server_error", { message: error instanceof Error ? error.message : String(error) });
  });

  // Bind 0.0.0.0 (IPv4 all-interfaces) so container port mapping and IPv4 probes
  // (Docker healthcheck hits 127.0.0.1) work; the Node default `::` is IPv6-only on some hosts.
  server.listen(opts.port, "0.0.0.0", () => {
    opts.log.info("health_server_listening", { port: opts.port });
  });

  return server;
};
