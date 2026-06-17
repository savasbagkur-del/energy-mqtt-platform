#!/usr/bin/env node
/**
 * Switch endurance / reliability test — gercek cihaza dönüşümlü AÇ/KAPAT komutlari gönderir,
 * RASTGELE aralarla ama TOPLAM hedef süreye (varsayilan 15 dk) yayar. Her toggle icin hem komut
 * ACK'ini hem de GERCEK röle degisimini dogrular.
 *
 * GERCEK ONAY: bu cihaz SwitchSta yollamadigi icin, anahtar durumu PRESTATE/AdfState1'den decode
 * edilir (AÇIK≈AdfState1>1000 / KAPALI≈AdfState1<=1000). Bu degeri API'nin /control-view
 * endpoint'inden okuruz (saha testiyle dogrulandi: KAPALI=488, AÇIK=57583).
 *
 * !!! FIZIKSEL: her toggle gercek röleyi degistirir. Cihaz basinda gözlem önerilir. !!!
 *
 * Kullanim:
 *   node switch-endurance-test.mjs --on=10 --off=10 --minutes=15
 *   node switch-endurance-test.mjs --on=10 --off=10 --minutes=15 --out=endurance.json
 *
 * Argümanlar / env:
 *   --api      (API_BASE)   default http://localhost:3001
 *   --sn       (SN)         default 24042809890002
 *   --on       sayisi       default 10   (AÇ komut adedi)
 *   --off      sayisi       default 10   (KAPAT komut adedi)
 *   --minutes  toplam sn    default 15   (komutlarin yayilacagi toplam süre, dk)
 *   --start    on|off|auto  default auto (mevcut durumun tersinden basla)
 *   --poll     ms           default 2000
 *   --out      JSON yolu    (ops.)
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
  onCount: int(args.on, 10),
  offCount: int(args.off, 10),
  minutes: int(args.minutes, 15),
  start: (args.start || "auto").toLowerCase(),
  pollMs: int(args.poll, 2000),
  out: args.out || null
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const fmtSec = (v) => (v === null || v === undefined ? "-" : `${(v / 1000).toFixed(1)}s`);

async function http(method, path) {
  const res = await fetch(`${CFG.apiBase}${path}`, { method });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function controlView() {
  const { status, json } = await http("GET", `/devices/${CFG.sn}/control-view`);
  return status === 200 ? json : null;
}

/** Reconciler komutu üretir; toggle'dan sonra ilgili force_switch komutunu bul. */
async function discoverCommandId(type, afterMs) {
  const deadline = nowMs() + 18000;
  while (nowMs() < deadline) {
    const { json } = await http("GET", `/devices/${CFG.sn}/commands`);
    const items = (json && json.items) || [];
    const c = items
      .filter((x) => x.command_type === type && new Date(x.created_at).getTime() >= afterMs - 3000)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (c) return String(c.id);
    await sleep(800);
  }
  return null;
}

/** N-1 rastgele aralik (en az 15sn), toplam hedef süreye normalize. */
function buildGaps(count, totalMs) {
  const G = Math.max(0, count - 1);
  if (G === 0) return [];
  const minGap = 15000;
  const budget = Math.max(G * minGap, totalMs);
  const raw = Array.from({ length: G }, () => 0.5 + Math.random());
  const s = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => minGap + Math.round((w / s) * (budget - G * minGap)));
}

/** AÇ/KAPAT dizisini dönüşümlü kur (start ile baslayarak). */
function buildSequence(onCount, offCount, start) {
  const seq = [];
  let on = onCount;
  let off = offCount;
  let cur = start === "off" ? 0 : 1;
  while (on > 0 || off > 0) {
    if (cur === 1 && on > 0) {
      seq.push(1);
      on--;
      cur = 0;
    } else if (cur === 0 && off > 0) {
      seq.push(0);
      off--;
      cur = 1;
    } else {
      cur = cur === 1 ? 0 : 1;
    }
  }
  return seq;
}

async function runToggle(idx, total, target, confirmWindowMs) {
  const label = target === 1 ? "AÇ " : "KAPAT";
  const tSend = nowMs();
  const trig = await http("POST", `/devices/${CFG.sn}/commands/force-switch-${target}`);
  if (trig.status !== 202 && trig.status !== 201) {
    console.log(`  #${idx}/${total} ${label} -> TETIKLEME HATASI HTTP ${trig.status}`);
    return { idx, target, error: `trigger_${trig.status}` };
  }
  const type = target === 1 ? "force_switch_1" : "force_switch_0";
  const commandId = await discoverCommandId(type, tSend);

  let ackAt = null;
  let publishedAt = null;
  let attempts = null;
  let status = null;
  let fieldConfirmedAt = null;
  let adf1 = null;
  let prestate = null;

  const deadline = nowMs() + confirmWindowMs;
  while (nowMs() < deadline) {
    await sleep(CFG.pollMs);
    const cv = await controlView();
    if (cv) {
      adf1 = cv.meter.adfState1;
      prestate = cv.meter.prestate;
      const expected = target === 1 ? "on" : "off";
      if (fieldConfirmedAt === null && cv.switchDecoded === expected) {
        fieldConfirmedAt = nowMs();
      }
      const rc = (cv.recentCommands || []).find((c) => String(c.id) === String(commandId));
      if (rc) {
        status = rc.status;
        publishedAt = rc.published_at;
        ackAt = rc.ack_at;
        attempts = rc.attempt_count;
      }
    }
    if (ackAt && fieldConfirmedAt) break;
  }

  const ackLatencyMs = publishedAt && ackAt ? new Date(ackAt).getTime() - new Date(publishedAt).getTime() : null;
  const fieldConfirmMs = fieldConfirmedAt ? fieldConfirmedAt - tSend : null;
  console.log(
    `  #${idx}/${total} ${label} cmd=${commandId ?? "-"} ack=${ackAt ? "✓" : "✗"}` +
    `${ackLatencyMs !== null ? `(${ackLatencyMs}ms)` : ""} deneme=${attempts ?? "-"} ` +
    `roleDegisti=${fieldConfirmedAt ? "✓ " + fmtSec(fieldConfirmMs) : "✗"} AdfState1=${adf1} PRESTATE=${prestate} status=${status ?? "-"}`
  );

  return {
    idx,
    target,
    commandId,
    acked: !!ackAt,
    ackLatencyMs,
    attempts,
    status,
    fieldConfirmed: !!fieldConfirmedAt,
    fieldConfirmMs,
    adfState1: adf1,
    prestate
  };
}

function stats(nums) {
  const xs = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  const p = (q) => xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];
  return { n: xs.length, min: xs[0], avg: Math.round(sum / xs.length), p95: p(0.95), max: xs[xs.length - 1] };
}

async function main() {
  console.log("Switch Endurance / Reliability Test");
  console.log(JSON.stringify(CFG));
  console.log("!!! FIZIKSEL MOD: gercek role tekrar tekrar degisecek. !!!");

  const health = await http("GET", "/health");
  if (health.status !== 200) {
    console.error(`API erisilemiyor (${CFG.apiBase}). API'yi baslat.`);
    process.exit(1);
  }

  // start yönü
  let start = CFG.start;
  if (start === "auto") {
    const cv = await controlView();
    const cur = cv ? cv.switchDecoded : "off";
    start = cur === "on" ? "off" : "on"; // mevcut durumun tersinden basla (gözle görülür degisim)
    console.log(`  mevcut durum=${cur} -> ilk komut=${start.toUpperCase()}`);
  }

  const seq = buildSequence(CFG.onCount, CFG.offCount, start);
  const total = seq.length;
  const gaps = buildGaps(total, CFG.minutes * 60 * 1000);
  const plannedSec = Math.round((gaps.reduce((a, b) => a + b, 0)) / 1000);
  console.log(`  toplam ${total} toggle (${CFG.onCount} AÇ + ${CFG.offCount} KAPAT), planlanan yayilim ~${plannedSec}s`);
  console.log(`  rastgele araliklar(sn): [${gaps.map((g) => Math.round(g / 1000)).join(", ")}]`);

  const t0 = nowMs();
  const results = [];
  for (let i = 0; i < total; i++) {
    const target = seq[i];
    const gapAfter = i < total - 1 ? gaps[i] : 0;
    // onay penceresi: bir sonraki komuta kadar (en fazla 90sn), en az 20sn
    const confirmWindow = i < total - 1 ? Math.max(20000, Math.min(gapAfter - 3000, 90000)) : 60000;
    results.push(await runToggle(i + 1, total, target, confirmWindow));
    const elapsed = nowMs() - t0;
    if (i < total - 1) {
      const remainingGap = gapAfter - confirmWindow;
      if (remainingGap > 0) await sleep(remainingGap);
    }
    console.log(`     (gecen sure: ${fmtSec(elapsed)})`);
  }

  // temizlik: aktif iradeyi kaldir
  await http("DELETE", `/devices/${CFG.sn}/desired/switch`);

  // ---- özet ----
  console.log(`\n===== OZET (${results.length} toggle, gercek sure ${fmtSec(nowMs() - t0)}) =====`);
  const valid = results.filter((r) => !r.error);
  const acked = valid.filter((r) => r.acked);
  const confirmed = valid.filter((r) => r.fieldConfirmed);
  const onR = valid.filter((r) => r.target === 1);
  const offR = valid.filter((r) => r.target === 0);
  console.log(`  ACK orani          : ${acked.length}/${valid.length}`);
  console.log(`  ROLE DEGISTI (gercek): ${confirmed.length}/${valid.length}  <-- fiziksel basari`);
  console.log(`  AÇ  role degisti   : ${onR.filter((r) => r.fieldConfirmed).length}/${onR.length}`);
  console.log(`  KAPAT role degisti : ${offR.filter((r) => r.fieldConfirmed).length}/${offR.length}`);

  const ackLat = stats(valid.map((r) => r.ackLatencyMs));
  const confMs = stats(valid.map((r) => r.fieldConfirmMs));
  const att = stats(valid.map((r) => r.attempts));
  if (ackLat) console.log(`  ACK gecikme        : min=${ackLat.min} avg=${ackLat.avg} p95=${ackLat.p95} max=${ackLat.max} ms`);
  if (confMs) console.log(`  role degisim suresi: min=${fmtSec(confMs.min)} avg=${fmtSec(confMs.avg)} p95=${fmtSec(confMs.p95)} max=${fmtSec(confMs.max)}`);
  if (att) console.log(`  deneme sayisi      : min=${att.min} avg=${att.avg} max=${att.max}`);

  const failures = valid.filter((r) => !r.fieldConfirmed);
  if (failures.length) {
    console.log(`  ONAYLANMAYAN toggle'lar: ${failures.map((r) => `#${r.idx}(${r.target === 1 ? "AÇ" : "KAPAT"})`).join(", ")}`);
  }

  if (CFG.out) {
    const fs = await import("node:fs");
    fs.writeFileSync(CFG.out, JSON.stringify({ config: CFG, sequence: seq, gaps, results, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`  JSON kaydedildi: ${CFG.out}`);
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
