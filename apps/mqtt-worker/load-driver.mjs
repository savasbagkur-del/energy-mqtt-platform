/**
 * Load driver: fires switch/refresh commands at a slice of the emulated fleet via the API, then the
 * caller measures reconcile success/latency from the DB (desired_set_at -> reconciled_at).
 *
 * Usage (PowerShell):
 *   $env:API_BASE="http://localhost:3002"; $env:COUNT="50"; $env:TARGET="0"; node load-driver.mjs
 */
const API_BASE = process.env.API_BASE ?? "http://localhost:3002";
const COUNT = Number(process.env.COUNT ?? 50);
const START = Number(process.env.START ?? 1);
const TARGET = String(process.env.TARGET ?? "0") === "1" ? 1 : 0;
const MODE = process.env.MODE ?? "switch"; // "switch" | "refresh"
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const SN_PREFIX = process.env.SN_PREFIX ?? "LOAD";

const pad = (i) => String(i).padStart(6, "0");
const sns = [];
for (let i = START; i < START + COUNT; i += 1) sns.push(`${SN_PREFIX}${pad(i)}`);

const fireOne = async (sn) => {
  const url =
    MODE === "refresh"
      ? `${API_BASE}/devices/${sn}/commands/refresh`
      : `${API_BASE}/devices/${sn}/commands/force-switch-${TARGET}`;
  try {
    const res = await fetch(url, { method: "POST" });
    return res.ok ? "ok" : `http_${res.status}`;
  } catch (e) {
    return `err_${e.message}`;
  }
};

const run = async () => {
  const t0 = Date.now();
  console.log("[driver] firing", { api: API_BASE, mode: MODE, target: TARGET, count: COUNT, start: START });
  const results = {};
  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < sns.length) {
      const my = idx;
      idx += 1;
      const r = await fireOne(sns[my]);
      results[r] = (results[r] ?? 0) + 1;
    }
  });
  await Promise.all(workers);
  console.log("[driver] done", { elapsedMs: Date.now() - t0, results, issuedAtIso: new Date(t0).toISOString() });
};

run();
