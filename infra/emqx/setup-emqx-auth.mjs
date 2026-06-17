#!/usr/bin/env node
/**
 * EMQX 5.x kimlik dogrulama (authentication) kurulumu — uretim brokeri icin.
 *
 * Ne yapar (idempotent):
 *   1. password_based + built_in_database authenticator'i olusturur (yoksa). Bu eklenince EMQX
 *      kimlik dogrulamayi ZORUNLU kilar; anonim/yanlis kimlikli istemciler reddedilir.
 *   2. Iki kullaniciyi upsert eder:
 *        - BACKEND kullanicisi (worker + API): tum sisteme erisir.
 *        - Paylasimli CIHAZ kullanicisi: TUM cihazlar ayni kullanici/parolayi kullanir; cihaz
 *          ayrimi backend'de SERI NUMARASI uzerinden yapilir (filo modeli).
 *   3. (opsiyonel, ENABLE_AUTHZ=true) built_in_database yetkilendirme (authz) kurar:
 *        - backend: her topic'e pub/sub
 *        - cihaz: yalnizca cihaz topic aileleri (sys/#, data/#)
 *        - eslesme yoksa: deny
 *
 * Kullanim:
 *   EMQX_API_URL=http://<broker>:18083 \
 *   EMQX_API_USER=<dashboard_admin> EMQX_API_PASS=<dashboard_pass> \
 *   BACKEND_MQTT_USERNAME=backend_worker BACKEND_MQTT_PASSWORD=... \
 *   DEVICE_MQTT_USERNAME=fleet_device   DEVICE_MQTT_PASSWORD=... \
 *   [ENABLE_AUTHZ=true] \
 *   node infra/emqx/setup-emqx-auth.mjs
 *
 * NOT: Bu script'i yalnizca calistirmaya HAZIR (cihazlarda dogru kimlik tanimli) brokere uygulayin;
 * authenticator eklendigi an yanlis kimlikli baglantilar reddedilir.
 */

const API_URL = (process.env.EMQX_API_URL ?? "http://localhost:18083").replace(/\/$/, "");
const API_USER = process.env.EMQX_API_USER ?? "admin";
const API_PASS = process.env.EMQX_API_PASS ?? "public";

const BACKEND_USER = process.env.BACKEND_MQTT_USERNAME ?? process.env.MQTT_USERNAME ?? "backend_worker";
const BACKEND_PASS = process.env.BACKEND_MQTT_PASSWORD ?? process.env.MQTT_PASSWORD ?? "";
const DEVICE_USER = process.env.DEVICE_MQTT_USERNAME ?? "fleet_device";
const DEVICE_PASS = process.env.DEVICE_MQTT_PASSWORD ?? "";
const ENABLE_AUTHZ = (process.env.ENABLE_AUTHZ ?? "false").toLowerCase() === "true";

const AUTHN_ID = "password_based:built_in_database";
const AUTHN_USERS = `/api/v5/authentication/${AUTHN_ID}/users`;
const AUTHZ_USERS = "/api/v5/authorization/sources/built_in_database/rules/users";

const fail = (msg) => {
  throw new Error(msg);
};

const login = async () => {
  const res = await fetch(`${API_URL}/api/v5/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: API_USER, password: API_PASS })
  });
  if (!res.ok) fail(`login failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.token) fail(`login returned no token: ${JSON.stringify(json)}`);
  return json.token;
};

const api = async (token, method, path, body) => {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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

const ensureAuthenticator = async (token) => {
  const list = await api(token, "GET", "/api/v5/authentication");
  if (!list.ok) fail(`list authenticators failed: ${list.status} ${list.raw}`);
  const exists = Array.isArray(list.body) && list.body.some((a) => a.id === AUTHN_ID);
  if (exists) {
    console.log("[emqx-auth] authenticator already present:", AUTHN_ID);
    return;
  }
  const created = await api(token, "POST", "/api/v5/authentication", {
    mechanism: "password_based",
    backend: "built_in_database",
    user_id_type: "username",
    password_hash_algorithm: { name: "sha256", salt_position: "suffix" }
  });
  if (!created.ok) fail(`create authenticator failed: ${created.status} ${created.raw}`);
  console.log("[emqx-auth] authenticator created:", AUTHN_ID);
};

const upsertUser = async (token, userId, password, label) => {
  if (!password) fail(`${label} password is empty — set the corresponding env var`);
  const add = await api(token, "POST", AUTHN_USERS, { user_id: userId, password });
  if (add.ok) {
    console.log(`[emqx-auth] user created: ${userId} (${label})`);
    return;
  }
  // Already exists -> update password to the desired value (idempotent rotation).
  if (add.status === 409 || add.status === 400) {
    const upd = await api(token, "PUT", `${AUTHN_USERS}/${encodeURIComponent(userId)}`, { password });
    if (!upd.ok) fail(`update user ${userId} failed: ${upd.status} ${upd.raw}`);
    console.log(`[emqx-auth] user updated: ${userId} (${label})`);
    return;
  }
  fail(`create user ${userId} failed: ${add.status} ${add.raw}`);
};

const ensureAuthzSource = async (token) => {
  // GET returns { sources: [...] } in EMQX 5.x (not a bare array).
  const res = await api(token, "GET", "/api/v5/authorization/sources");
  const list = Array.isArray(res.body)
    ? res.body
    : Array.isArray(res.body?.sources)
      ? res.body.sources
      : [];
  if (list.some((s) => s.type === "built_in_database")) {
    console.log("[emqx-auth] authz source already present: built_in_database");
    return;
  }
  const created = await api(token, "POST", "/api/v5/authorization/sources", {
    type: "built_in_database",
    enable: true
  });
  // Tolerate a concurrent/duplicate create as idempotent success.
  if (!created.ok && !created.raw?.includes("duplicated_authz_source_type")) {
    fail(`create authz source failed: ${created.status} ${created.raw}`);
  }
  console.log("[emqx-auth] authz source ready: built_in_database");
};

const setUserRules = async (token, username, rules) => {
  // Replace this user's rules: delete (ignore 404) then add fresh, so re-runs stay clean.
  await api(token, "DELETE", `${AUTHZ_USERS}/${encodeURIComponent(username)}`);
  const res = await api(token, "POST", AUTHZ_USERS, [{ username, rules }]);
  if (!res.ok) fail(`set authz rules for ${username} failed: ${res.status} ${res.raw}`);
  console.log(`[emqx-auth] authz rules set: ${username} (${rules.length} rule(s))`);
};

const configureAuthz = async (token) => {
  await ensureAuthzSource(token);
  await setUserRules(token, BACKEND_USER, [{ permission: "allow", action: "all", topic: "#" }]);
  await setUserRules(token, DEVICE_USER, [
    { permission: "allow", action: "all", topic: "sys/#" },
    { permission: "allow", action: "all", topic: "data/#" }
  ]);
  const settings = await api(token, "GET", "/api/v5/authorization/settings");
  const next = { ...(settings.body && typeof settings.body === "object" ? settings.body : {}), no_match: "deny" };
  const upd = await api(token, "PUT", "/api/v5/authorization/settings", next);
  if (!upd.ok) {
    console.warn(`[emqx-auth] WARN could not set no_match=deny: ${upd.status} ${upd.raw}`);
  } else {
    console.log("[emqx-auth] authz default no_match=deny");
  }
};

const main = async () => {
  console.log(`[emqx-auth] target ${API_URL} as ${API_USER} (authz=${ENABLE_AUTHZ})`);
  const token = await login();
  await ensureAuthenticator(token);
  await upsertUser(token, BACKEND_USER, BACKEND_PASS, "backend");
  await upsertUser(token, DEVICE_USER, DEVICE_PASS, "device(shared)");
  if (ENABLE_AUTHZ) {
    await configureAuthz(token);
  } else {
    console.log("[emqx-auth] authz skipped (set ENABLE_AUTHZ=true to enforce topic ACLs)");
  }
  console.log("[emqx-auth] done");
};

main().catch((error) => {
  console.error(`[emqx-auth] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
