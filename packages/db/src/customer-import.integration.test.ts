import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { findQuarantineMatchesForSn } from "./customer-import.js";
import { upsertDevice } from "./devices.js";

const dbUrl = process.env.DATABASE_URL;
let dbAvailable = false;
let skipReason = "DATABASE_URL not set";
let pool: Pool | null = null;

const p = (): Pool => {
  if (!pool) throw new Error("pool not ready");
  return pool;
};

test.before(async () => {
  if (!dbUrl) return;
  try {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch (e) {
    skipReason = e instanceof Error ? e.message : String(e);
  }
});

test.after(async () => {
  await pool?.end();
});

const baseUpsert = (sn: string, whitelistEnabled = false) => ({
  sn,
  productKey: "pk-test",
  lastSeenAt: new Date("2026-01-01T00:00:00Z"),
  lastMethod: "login",
  devname: "meter-a",
  softcode: "sc",
  softversion: "1",
  network: "4g",
  model: "M1",
  whitelistEnabled
});

test("findQuarantineMatchesForSn: matches unassigned registered device", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const sn = "SN-IMPORT-REG-1";
  await p().query(`DELETE FROM devices WHERE sn = $1`, [sn]);
  await p().query(
    `INSERT INTO devices (sn, registry_status, lifecycle_status, registered_at, updated_at)
     VALUES ($1, 'registered', 'active', NOW(), NOW())`,
    [sn]
  );
  const { best } = await findQuarantineMatchesForSn(p(), sn);
  assert.ok(best);
  assert.equal(best.sn, sn);
});

test("findQuarantineMatchesForSn: matches unassigned auto device (whitelist off)", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const sn = "SN-IMPORT-AUTO-1";
  await upsertDevice(p(), baseUpsert(sn, false));
  const { best, options } = await findQuarantineMatchesForSn(p(), sn);
  assert.ok(best);
  assert.equal(best.sn, sn);
  assert.equal(best.matchType, "exact");
  assert.equal(options.length, 1);
});

test("findQuarantineMatchesForSn: matches quarantined device (whitelist on)", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const sn = "SN-IMPORT-Q-1";
  await upsertDevice(p(), baseUpsert(sn, true));
  const { best } = await findQuarantineMatchesForSn(p(), sn);
  assert.ok(best);
  assert.equal(best.sn, sn);
});

test("findQuarantineMatchesForSn: ignores device already assigned to a customer", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const sn = "SN-IMPORT-ASSIGNED-1";
  await upsertDevice(p(), baseUpsert(sn, false));
  await p().query(
    `INSERT INTO customers (name, phone) VALUES ('Tmp Import Test', '05550001111') RETURNING id`
  );
  const cust = await p().query<{ id: string }>(
    `SELECT id::text FROM customers WHERE phone = '05550001111' ORDER BY created_at DESC LIMIT 1`
  );
  await p().query(`UPDATE devices SET customer_id = $1 WHERE sn = $2`, [cust.rows[0]!.id, sn]);
  const { best } = await findQuarantineMatchesForSn(p(), sn);
  assert.equal(best, null);
});
