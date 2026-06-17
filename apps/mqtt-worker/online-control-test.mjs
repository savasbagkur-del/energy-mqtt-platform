#!/usr/bin/env node
/**
 * Online control test module — gerçek cihaza karşı komut gönderir, dönüşü bekler ve
 * GÖNDERİM/ACK/DOĞRULAMA anlarını + gecikmeleri ölçer. Amaç: gerçek round-trip sürelerini
 * görüp ack_timeout / delivery window gibi timeout değerlerini veriye dayalı belirlemek.
 *
 * Her şeyi API üzerinden yapar (ayrı DB bağlantısı gerekmez):
 *   - tetikleme: POST /devices/:sn/commands/refresh | /commands/force-switch-0 | -1
 *   - izleme:    GET  /commands/:id      (komut satırı + olaylar)
 *   - alan deltası: GET /devices/:sn/latest-state
 *
 * GÜVENLİK: switch0/switch1 modu gerçek röleyi fiziksel olarak değiştirir. refresh moduw
 * salt-okunurdur (yan etki yok) ve süre kalibrasyonu için idealdir.
 *
 * Kullanım (örnekler):
 *   node online-control-test.mjs --mode=refresh --runs=5
 *   node online-control-test.mjs --mode=switch0 --runs=1 --timeout=240
 *   node online-control-test.mjs --mode=refresh --runs=3 --out=results.json
 *
 * Argümanlar / env:
 *   --api    (API_BASE)            default http://localhost:3001
 *   --sn     (SN)                  default 24042809890002
 *   --mode   (MODE)               refresh | switch0 | switch1   default refresh
 *   --runs   (RUNS)                default 1
 *   --timeout(PER_RUN_TIMEOUT_SEC) tek koşuda terminal beklenecek sn   default 180
 *   --poll   (POLL_MS)             durum sorgu aralığı ms             default 1000
 *   --gap    (GAP_SEC)             koşular arası bekleme sn           default 5
 *   --out    (OUT)                 JSON çıktısı dosya yolu (ops.)
 */

const argv = process.argv.slice(2);
const args = {};
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith("--")) args[a.slice(2)] = "true";
}
const env = process.env;
const int = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};

const CFG = {
  apiBase: (args.api || env.API_BASE || "http://localhost:3001").replace(/\/$/, ""),
  sn: args.sn || env.SN || "24042809890002",
  mode: (args.mode || env.MODE || "refresh").toLowerCase(),
  runs: int(args.runs ?? env.RUNS, 1),
  perRunTimeoutSec: int(args.timeout ?? env.PER_RUN_TIMEOUT_SEC, 180),
  pollMs: int(args.poll ?? env.POLL_MS, 1000),
  gapSec: int(args.gap ?? env.GAP_SEC, 5),
  out: args.out || env.OUT || null
};

const MODE_MAP = {
  refresh: { path: (sn) => `/devices/${sn}/commands/refresh`, type: "refresh", physical: false },
  switch0: { path: (sn) => `/devices/${sn}/commands/force-switch-0`, type: "force_switch_0", physical: true },
  switch1: { path: (sn) => `/devices/${sn}/commands/force-switch-1`, type: "force_switch_1", physical: true }
};
const MODE = MODE_MAP[CFG.mode];
if (!MODE) {
  console.error(`Gecersiz --mode=${CFG.mode}. Gecerli: refresh | switch0 | switch1`);
  process.exit(1);
}

const TERMINAL = new Set([
  "verified_success",
  "verified_success_with_late_confirmation",
  "verified_mismatch",
  "failed",
  "delivery_timeout",
  "expired",
  "cancelled"
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const ms = (a, b) => (a && b ? new Date(a).getTime() - new Date(b).getTime() : null);
const fmtMs = (v) => (v === null || v === undefined ? "-" : `${v}ms`);
const fmtSec = (v) => (v === null || v === undefined ? "-" : `${(v / 1000).toFixed(1)}s`);

async function http(method, path, body) {
  const res = await fetch(`${CFG.apiBase}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Deep-search an object for the first occurrence of any of the given keys. */
function findNested(obj, keys, depth = 0) {
  if (obj === null || typeof obj !== "object" || depth > 6) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== null && typeof obj[k] !== "object") {
      return obj[k];
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findNested(v, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const METER_FIELDS = ["SwitchSta", "PRESTATE", "AdfState1", "AdfState2", "OweMoney", "Balance", "EPI"];

async function snapshotMeter() {
  const { status, json } = await http("GET", `/devices/${CFG.sn}/latest-state`);
  if (status !== 200 || !json) return { available: false };
  const src = json.last_summary ?? json.last_payload ?? json;
  const out = { available: true, switch_state: json.switch_state ?? null, last_method: json.last_method ?? null };
  for (const f of METER_FIELDS) {
    const v = findNested(src, [f]);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

/** For switch modes the command is created by the reconciler; discover it after triggering. */
async function discoverSwitchCommandId(afterMs) {
  const deadline = nowMs() + 20000;
  while (nowMs() < deadline) {
    const { json } = await http("GET", `/devices/${CFG.sn}/commands`);
    const items = (json && json.items) || [];
    const candidate = items
      .filter((c) => c.command_type === MODE.type && new Date(c.created_at).getTime() >= afterMs - 3000)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (candidate) return String(candidate.id);
    await sleep(1000);
  }
  return null;
}

function summarizeAck(ackPayload) {
  if (!ackPayload || typeof ackPayload !== "object") return { res: null, hasSwitchSta: false, switchSta: null };
  const res = findNested(ackPayload, ["res"]);
  const switchSta = findNested(ackPayload, ["SwitchSta"]);
  return {
    res: res ?? null,
    hasSwitchSta: switchSta !== undefined,
    switchSta: switchSta ?? null
  };
}

async function runOnce(runIndex) {
  console.log(`\n===== KOSU ${runIndex}/${CFG.runs}  mode=${CFG.mode}  sn=${CFG.sn} =====`);
  const before = await snapshotMeter();
  if (before.available) {
    console.log(`  [oncesi] switch_state=${before.switch_state ?? "-"} ` +
      METER_FIELDS.filter((f) => f in before).map((f) => `${f}=${before[f]}`).join(" "));
  }

  const tReq = nowMs();
  const trigger = await http("POST", MODE.path(CFG.sn));
  let commandId = null;

  if (MODE.physical) {
    if (trigger.status !== 202 && trigger.status !== 201) {
      console.error(`  TETIKLEME HATASI status=${trigger.status} body=${JSON.stringify(trigger.json)}`);
      return { run: runIndex, error: `trigger_${trigger.status}`, triggerBody: trigger.json };
    }
    console.log(`  irade kaydedildi (desired_state). reconciler komutu uretecek...`);
    commandId = await discoverSwitchCommandId(tReq);
    if (!commandId) {
      console.error("  reconciler 20sn icinde force_switch komutu uretmedi (cihaz offline / single-flight?).");
      return { run: runIndex, error: "no_command_issued", triggerBody: trigger.json };
    }
  } else {
    if (trigger.status !== 201 || !trigger.json || trigger.json.id === undefined) {
      console.error(`  TETIKLEME HATASI status=${trigger.status} body=${JSON.stringify(trigger.json)}`);
      return { run: runIndex, error: `trigger_${trigger.status}`, triggerBody: trigger.json };
    }
    commandId = String(trigger.json.id);
  }
  const apiLatencyMs = nowMs() - tReq;
  console.log(`  commandId=${commandId} (apiLatency=${apiLatencyMs}ms)`);

  const deadline = nowMs() + CFG.perRunTimeoutSec * 1000;
  let detail = null;
  let terminalWallMs = null;
  let lastStatus = null;
  while (nowMs() < deadline) {
    await sleep(CFG.pollMs);
    const { status, json } = await http("GET", `/commands/${commandId}`);
    if (status !== 200 || !json || !json.command) continue;
    detail = json;
    const c = json.command;
    if (c.status !== lastStatus) {
      const t = ((nowMs() - tReq) / 1000).toFixed(1);
      console.log(`  t+${t}s status=${c.status} attempt=${c.attempt_count ?? "-"} ` +
        `ack=${c.ack_at ? "yes" : "no"} verified=${c.verified_at ? "yes" : "no"}`);
      lastStatus = c.status;
    }
    if (TERMINAL.has(c.status)) {
      terminalWallMs = nowMs();
      break;
    }
  }

  const c = (detail && detail.command) || {};
  const events = (detail && detail.events) || [];
  const publishedEvents = events.filter((e) => e.event_type === "published");
  const firstPublished = publishedEvents.length ? publishedEvents[0].created_at : c.published_at ?? null;
  const lastPublished = publishedEvents.length ? publishedEvents[publishedEvents.length - 1].created_at : c.published_at ?? null;
  const attempts = publishedEvents.length || (c.published_at ? 1 : 0);

  const ackFromLast = ms(c.ack_at, lastPublished);
  const ackFromFirst = ms(c.ack_at, firstPublished);
  const verifyMs = ms(c.verified_at, c.ack_at);
  const e2eMs = ms(c.verified_at ?? c.completed_at, firstPublished);
  const wallToTerminalMs = terminalWallMs ? terminalWallMs - tReq : null;
  const ackInfo = summarizeAck(c.ack_payload);

  const after = await snapshotMeter();

  // ---- per-run report ----
  console.log(`  --- SONUC ---`);
  console.log(`  final_status      : ${c.status ?? "(timeout)"}`);
  console.log(`  attempts (publish): ${attempts}`);
  console.log(`  GONDERIM (ilk)    : ${firstPublished ?? "-"}`);
  console.log(`  GONDERIM (son)    : ${lastPublished ?? "-"}`);
  console.log(`  DONUS (ack_at)    : ${c.ack_at ?? "- (ack gelmedi)"}`);
  console.log(`  ack <- son publish: ${fmtMs(ackFromLast)}   (tek denemede cihazin cevap suresi)`);
  console.log(`  ack <- ilk publish: ${fmtMs(ackFromFirst)} ${fmtSec(ackFromFirst)}  (retrylerle toplam)`);
  console.log(`  verify suresi     : ${fmtMs(verifyMs)}`);
  console.log(`  uctan-uca         : ${fmtMs(e2eMs)} ${fmtSec(e2eMs)}`);
  console.log(`  duvar saati toplam: ${fmtMs(wallToTerminalMs)} ${fmtSec(wallToTerminalMs)}`);
  console.log(`  ACK res           : ${ackInfo.res}   SwitchSta var mi: ${ackInfo.hasSwitchSta} (${ackInfo.switchSta})`);
  if (before.available && after.available) {
    const changed = METER_FIELDS.filter((f) => f in before && f in after && String(before[f]) !== String(after[f]));
    console.log(`  alan degisimi     : ${changed.length ? changed.map((f) => `${f}: ${before[f]} -> ${after[f]}`).join(", ") : "(degisen alan yok)"}`);
  }

  return {
    run: runIndex,
    commandId,
    mode: CFG.mode,
    final_status: c.status ?? null,
    attempts,
    apiLatencyMs,
    firstPublished,
    lastPublished,
    ackAt: c.ack_at ?? null,
    verifiedAt: c.verified_at ?? null,
    completedAt: c.completed_at ?? null,
    ackFromLastMs: ackFromLast,
    ackFromFirstMs: ackFromFirst,
    verifyMs,
    e2eMs,
    wallToTerminalMs,
    ack: ackInfo,
    meterBefore: before,
    meterAfter: after
  };
}

function stats(nums) {
  const xs = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  const p = (q) => xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];
  return { n: xs.length, min: xs[0], avg: Math.round(sum / xs.length), max: xs[xs.length - 1], p95: p(0.95) };
}

async function main() {
  console.log("Online Control Test Module");
  console.log(JSON.stringify(CFG));
  if (MODE.physical) {
    console.log("!!! FIZIKSEL MOD: gercek role degisecek. Cihaz basinda gozlem onerilir. !!!");
  }
  // API ayakta mi?
  const health = await http("GET", "/health");
  if (health.status !== 200) {
    console.error(`API erisilemiyor (${CFG.apiBase}/health -> ${health.status}). API'yi baslat.`);
    process.exit(1);
  }

  const results = [];
  for (let i = 1; i <= CFG.runs; i++) {
    results.push(await runOnce(i));
    if (i < CFG.runs) await sleep(CFG.gapSec * 1000);
  }

  // ---- aggregate ----
  console.log(`\n===== OZET (${results.length} kosu) =====`);
  const ok = results.filter((r) => r.final_status === "verified_success" || r.final_status === "verified_success_with_late_confirmation");
  const acked = results.filter((r) => r.ackAt);
  console.log(`  basarili (verified): ${ok.length}/${results.length}`);
  console.log(`  ACK alindi         : ${acked.length}/${results.length}`);
  const byStatus = {};
  for (const r of results) byStatus[r.final_status ?? "timeout"] = (byStatus[r.final_status ?? "timeout"] || 0) + 1;
  console.log(`  durum dagilimi     : ${JSON.stringify(byStatus)}`);

  const aFirst = stats(results.map((r) => r.ackFromFirstMs));
  const aLast = stats(results.map((r) => r.ackFromLastMs));
  const attempts = stats(results.map((r) => r.attempts));
  const e2e = stats(results.map((r) => r.e2eMs));
  if (aLast) console.log(`  ack<-son publish   : min=${aLast.min} avg=${aLast.avg} p95=${aLast.p95} max=${aLast.max} ms`);
  if (aFirst) console.log(`  ack<-ilk publish   : min=${fmtSec(aFirst.min)} avg=${fmtSec(aFirst.avg)} p95=${fmtSec(aFirst.p95)} max=${fmtSec(aFirst.max)}`);
  if (attempts) console.log(`  deneme sayisi      : min=${attempts.min} avg=${attempts.avg} max=${attempts.max}`);
  if (e2e) console.log(`  uctan-uca          : min=${fmtSec(e2e.min)} avg=${fmtSec(e2e.avg)} max=${fmtSec(e2e.max)}`);

  // ---- timeout onerileri (gozlemlenen veriye dayali) ----
  console.log(`\n  --- TIMEOUT ONERILERI (gozleme dayali) ---`);
  if (aLast && aLast.n) {
    const ackTo = Math.max(15, Math.ceil((aLast.p95 / 1000) * 1.5));
    console.log(`  ack_timeout_sec    ~ ${ackTo}s  (p95 tek-deneme cevabi ${fmtSec(aLast.p95)} x1.5, taban 15s)`);
  } else {
    console.log(`  ack_timeout_sec    : olculemedi (ACK gelmedi) -> cihaz/erisim incele`);
  }
  if (aFirst && aFirst.n) {
    const ttl = Math.ceil((aFirst.max / 1000) * 1.5);
    console.log(`  delivery window / command_ttl_sec ~ ${ttl}s  (en kotu toplam ${fmtSec(aFirst.max)} x1.5)`);
  }
  console.log(`  not: cihaz 2-3 cycle sonra cevap verebildigi icin tek-deneme suresi kisa, toplam sure uzun olabilir.`);

  if (CFG.out) {
    const fs = await import("node:fs");
    fs.writeFileSync(CFG.out, JSON.stringify({ config: CFG, results, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n  JSON kaydedildi: ${CFG.out}`);
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
