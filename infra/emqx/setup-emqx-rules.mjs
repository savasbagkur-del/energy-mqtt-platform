#!/usr/bin/env node
/**
 * EMQX 5.x rule-engine kurulumu: presence (connect/disconnect) + binding (clientid<->sn) ogrenme.
 *
 * Worker bu cikti topic'lerini dinler:
 *   presence/connected, presence/disconnected  -> device_presence (online/offline)
 *   meta/publish                                -> mqtt_client_bindings (clientid -> product_key, sn)
 *
 * Kullanim (yerel):
 *   node infra/emqx/setup-emqx-rules.mjs
 * Kullanim (uzak/prod broker):
 *   EMQX_API_URL=http://<broker>:18083 EMQX_API_USER=<user> EMQX_API_PASS=<pass> \
 *     node infra/emqx/setup-emqx-rules.mjs
 *
 * Idempotent: ayni id'li kural varsa once silinir, sonra yeniden olusturulur.
 */

const API_URL = (process.env.EMQX_API_URL ?? "http://localhost:18083").replace(/\/$/, "");
const API_USER = process.env.EMQX_API_USER ?? "worker_live_01";
const API_PASS = process.env.EMQX_API_PASS ?? "Wrk3rAws2026!";

const RULES = [
  {
    id: "presence_connected",
    sql: 'SELECT clientid, username, \'connected\' as event FROM "$events/client_connected"',
    actions: [
      {
        function: "republish",
        args: {
          topic: "presence/connected",
          qos: 1,
          retain: false,
          payload: '{"clientid":"${clientid}","username":"${username}","event":"connected"}'
        }
      }
    ]
  },
  {
    id: "presence_disconnected",
    sql: 'SELECT clientid, username, \'disconnected\' as event FROM "$events/client_disconnected"',
    actions: [
      {
        function: "republish",
        args: {
          topic: "presence/disconnected",
          qos: 1,
          retain: false,
          payload: '{"clientid":"${clientid}","username":"${username}","event":"disconnected"}'
        }
      }
    ]
  },
  {
    // Binding ogrenme: cihazlar baglandiginda dusuk-frekansli sys/dev/{pk}/{sn} mesaji yayinlar.
    // Buradan clientid<->topic eslemesini ogreniriz (gateway/konsantrator uyumlu, dusuk yuk).
    id: "binding_learn",
    sql: 'SELECT clientid, topic FROM "sys/dev/#"',
    actions: [
      {
        function: "republish",
        args: {
          topic: "meta/publish",
          qos: 1,
          retain: false,
          payload: '{"clientid":"${clientid}","topic":"${topic}"}'
        }
      }
    ]
  }
];

const login = async () => {
  const res = await fetch(`${API_URL}/api/v5/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: API_USER, password: API_PASS })
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.token) {
    throw new Error(`login returned no token: ${JSON.stringify(json)}`);
  }
  return json.token;
};

const deleteRuleIfExists = async (token, id) => {
  const res = await fetch(`${API_URL}/api/v5/rules/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
  // 204 = deleted, 404 = yoktu; ikisi de OK
  if (res.status !== 204 && res.status !== 404) {
    console.warn(`[emqx-rules] delete ${id} unexpected status ${res.status}: ${await res.text()}`);
  }
};

const createRule = async (token, rule) => {
  const res = await fetch(`${API_URL}/api/v5/rules`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(rule)
  });
  if (!res.ok) {
    throw new Error(`create ${rule.id} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
};

const main = async () => {
  console.log(`[emqx-rules] target ${API_URL} as ${API_USER}`);
  const token = await login();
  for (const rule of RULES) {
    await deleteRuleIfExists(token, rule.id);
    const created = await createRule(token, rule);
    console.log(`[emqx-rules] applied ${rule.id} (enabled=${created.enable ?? "?"})`);
  }
  console.log("[emqx-rules] done");
};

main().catch((error) => {
  console.error(`[emqx-rules] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
