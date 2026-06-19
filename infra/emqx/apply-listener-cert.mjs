#!/usr/bin/env node
/**
 * EMQX 5.x SSL listener'ina (varsayilan ssl:default) verilen PEM sertifika + anahtari uygular.
 *
 * EMQX, certfile/keyfile alanlarina dosya YOLU yerine PEM ICERIGI verildiginde icerigi kendi
 * yonettigi bir dosyaya (data/certs/...) yazar — dashboard'dan yapistirmakla ayni etki. Boylece
 * Let's Encrypt yenilemesinden sonra bu script'i calistirmak listener'i hot-reload eder; cihaz
 * baglantilarini kesmeden yeni sertifikaya gecer.
 *
 * Kullanim:
 *   EMQX_API_URL=http://127.0.0.1:18083 EMQX_API_USER=admin EMQX_API_PASS=... \
 *   CERT_PATH=/etc/letsencrypt/live/mqtt.volt4amper.com/fullchain.pem \
 *   KEY_PATH=/etc/letsencrypt/live/mqtt.volt4amper.com/privkey.pem \
 *   [LISTENER_ID=ssl:default] \
 *   node apply-listener-cert.mjs
 */
import { readFileSync } from "node:fs";

const API_URL = (process.env.EMQX_API_URL ?? "http://127.0.0.1:18083").replace(/\/$/, "");
const API_USER = process.env.EMQX_API_USER ?? "admin";
const API_PASS = process.env.EMQX_API_PASS ?? "public";
const LISTENER_ID = process.env.LISTENER_ID ?? "ssl:default";
const CERT_PATH = process.env.CERT_PATH;
const KEY_PATH = process.env.KEY_PATH;

const fail = (msg) => {
  throw new Error(msg);
};

const api = async (token, method, path, body) => {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed, raw: text };
};

const login = async () => {
  const res = await api(undefined, "POST", "/api/v5/login", { username: API_USER, password: API_PASS });
  if (!res.ok || !res.body?.token) fail(`login failed: ${res.status} ${res.raw}`);
  return res.body.token;
};

const main = async () => {
  if (!CERT_PATH || !KEY_PATH) fail("CERT_PATH ve KEY_PATH ver");
  const cert = readFileSync(CERT_PATH, "utf8");
  const key = readFileSync(KEY_PATH, "utf8");
  if (!cert.includes("BEGIN CERTIFICATE")) fail(`CERT_PATH gecerli PEM degil: ${CERT_PATH}`);
  if (!key.includes("PRIVATE KEY")) fail(`KEY_PATH gecerli PEM degil: ${KEY_PATH}`);

  console.log(`[apply-cert] ${API_URL} listener=${LISTENER_ID}`);
  const token = await login();

  const cur = await api(token, "GET", `/api/v5/listeners/${encodeURIComponent(LISTENER_ID)}`);
  if (!cur.ok || typeof cur.body !== "object") fail(`listener GET failed: ${cur.status} ${cur.raw}`);

  // GET ciktisindan SADECE runtime/stat alanlarini at; type, id, bind vb. config alanlari kalmali
  // (PUT 'type' alanini zorunlu ister). config'i PEM iceriklerini gomerek geri gonder.
  const next = { ...cur.body };
  for (const k of ["running", "current_connections", "node", "status", "node_status"]) {
    delete next[k];
  }
  next.ssl_options = { ...(cur.body.ssl_options ?? {}), certfile: cert, keyfile: key };

  const upd = await api(token, "PUT", `/api/v5/listeners/${encodeURIComponent(LISTENER_ID)}`, next);
  if (!upd.ok) fail(`listener PUT failed: ${upd.status} ${upd.raw}`);
  console.log("[apply-cert] listener guncellendi (yeni sertifika uygulandi)");

  // Dogrula: certfile artik yeni bir data/certs yoluna isaret etmeli.
  const after = await api(token, "GET", `/api/v5/listeners/${encodeURIComponent(LISTENER_ID)}`);
  const cf = after.body?.ssl_options?.certfile;
  console.log(`[apply-cert] aktif certfile: ${cf}`);
  console.log("[apply-cert] tamam");
};

main().catch((e) => {
  console.error(`[apply-cert] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
