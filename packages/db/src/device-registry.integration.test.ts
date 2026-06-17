import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import {
  approveQuarantinedDevice,
  bulkRegisterDevices,
  createCustomer,
  createPropertyType,
  getDeviceRegistry,
  listDevicesRegistry,
  registerDevice,
  setDeviceLifecycle
} from "./device-registry.js";
import { getDeviceBySn, upsertDevice } from "./devices.js";
import { isManagedRegistryStatus } from "./types.js";

/**
 * DB integration tests for the device registry + whitelist + upsertDevice path.
 *
 * These exercise real SQL against a throwaway PostgreSQL database, because the class of bug we
 * shipped to live testing (the upsertDevice `$3::timestamptz` type-deduction regression) cannot be
 * caught by pure unit tests. The suite provisions a fresh `communication_regtest` database, runs all
 * migrations, and drops it on teardown. If no PostgreSQL is reachable, every test is SKIPPED (so the
 * default `pnpm test` stays green without infra) — point it at a server via the REGTEST_PG_* envs.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, "../migrations");

const PG = {
  host: process.env.REGTEST_PG_HOST ?? process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.REGTEST_PG_PORT ?? process.env.POSTGRES_PORT ?? 5433),
  user: process.env.REGTEST_PG_USER ?? process.env.POSTGRES_USER ?? "postgres",
  password: process.env.REGTEST_PG_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? "postgres",
  adminDb: process.env.REGTEST_PG_ADMIN_DB ?? "postgres"
};
const TEST_DB = process.env.REGTEST_PG_DB ?? "communication_regtest";

let pool: Pool | null = null;
let dbAvailable = false;
let skipReason = "";

const runMigrations = async (target: Pool): Promise<void> => {
  await target.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );
  const files = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await target.query("BEGIN");
    try {
      await target.query(sql);
      await target.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await target.query("COMMIT");
    } catch (error) {
      await target.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

before(async () => {
  const admin = new Pool({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password,
    database: PG.adminDb,
    max: 1,
    connectionTimeoutMillis: 3000
  });
  try {
    await admin.query("SELECT 1");
  } catch (error) {
    skipReason = `postgres not reachable at ${PG.host}:${PG.port} (${error instanceof Error ? error.message : String(error)})`;
    await admin.end().catch(() => {});
    return;
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end().catch(() => {});
  }
  pool = new Pool({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password,
    database: TEST_DB,
    max: 4
  });
  await runMigrations(pool);
  dbAvailable = true;
});

after(async () => {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  if (!dbAvailable) {
    return;
  }
  const admin = new Pool({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password,
    database: PG.adminDb,
    max: 1
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  } finally {
    await admin.end().catch(() => {});
  }
});

beforeEach(async () => {
  if (!dbAvailable || !pool) {
    return;
  }
  // Keep migration-seeded property_types; reset the rest for deterministic list/filter tests.
  await pool.query("TRUNCATE devices, customers RESTART IDENTITY CASCADE");
});

const p = (): Pool => {
  assert.ok(pool, "pool should be initialized");
  return pool;
};

const seenAt = new Date("2026-01-01T00:00:00.000Z");
const baseUpsert = (sn: string, whitelistEnabled = false) => ({
  sn,
  productKey: "pk-test",
  lastSeenAt: seenAt,
  lastMethod: "update",
  devname: "meter-a",
  softcode: "sc1",
  softversion: "1.0.0",
  network: { rssi: -70, type: "lte" },
  whitelistEnabled
});

// ---------------------------------------------------------------------------
// upsertDevice — the regressed path
// ---------------------------------------------------------------------------

test("upsertDevice: new device (whitelist off) -> auto + commissioned, no type error", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await upsertDevice(p(), baseUpsert("SN-AUTO-1"));
  const row = await getDeviceBySn(p(), "SN-AUTO-1");
  assert.ok(row);
  assert.equal(row.registry_status, "auto");
  assert.equal(row.lifecycle_status, "commissioned");
  assert.ok(row.commissioned_at, "commissioned_at should be set on first contact");
  assert.equal(row.product_key, "pk-test");
});

test("upsertDevice: new device (whitelist on) -> quarantined + unknown + no commission", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await upsertDevice(p(), baseUpsert("SN-Q-1", true));
  const row = await getDeviceBySn(p(), "SN-Q-1");
  assert.ok(row);
  assert.equal(row.registry_status, "quarantined");
  assert.equal(row.lifecycle_status, "unknown");
  assert.equal(row.commissioned_at, null);
});

test("upsertDevice: re-contacting a quarantined device keeps it quarantined", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await upsertDevice(p(), baseUpsert("SN-Q-2", true));
  // Second contact arrives while whitelist is still on; it must NOT auto-promote/commission.
  await upsertDevice(p(), { ...baseUpsert("SN-Q-2", true), lastSeenAt: new Date("2026-01-02T00:00:00Z") });
  const row = await getDeviceBySn(p(), "SN-Q-2");
  assert.ok(row);
  assert.equal(row.registry_status, "quarantined");
  assert.equal(row.lifecycle_status, "unknown");
  assert.equal(row.commissioned_at, null);
});

test("upsertDevice: re-contacting an auto device -> active, commissioned_at preserved, COALESCE keeps fields", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await upsertDevice(p(), baseUpsert("SN-AUTO-2"));
  const first = await getDeviceBySn(p(), "SN-AUTO-2");
  // Second contact with null optional fields must not wipe existing values (COALESCE).
  await upsertDevice(p(), {
    sn: "SN-AUTO-2",
    productKey: null,
    lastSeenAt: new Date("2026-02-01T00:00:00Z"),
    lastMethod: "login",
    devname: null,
    softcode: null,
    softversion: null,
    network: null,
    whitelistEnabled: false
  });
  const row = await getDeviceBySn(p(), "SN-AUTO-2");
  assert.ok(row && first);
  assert.equal(row.lifecycle_status, "active");
  assert.equal(row.registry_status, "auto");
  assert.ok(row.commissioned_at && first.commissioned_at);
  assert.equal(
    new Date(row.commissioned_at).getTime(),
    new Date(first.commissioned_at).getTime(),
    "commissioned_at stays at first-contact time"
  );
  assert.equal(row.devname, "meter-a", "null devname must not overwrite existing");
  assert.equal(row.product_key, "pk-test", "null productKey must not overwrite existing");
  assert.equal(row.last_method, "login", "last_method always updates");
});

// ---------------------------------------------------------------------------
// registerDevice
// ---------------------------------------------------------------------------

test("registerDevice: brand-new SN -> registered + registered lifecycle + registered_at", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await registerDevice(p(), { sn: "SN-REG-1", label: "Kapı 1" });
  const row = await getDeviceRegistry(p(), "SN-REG-1");
  assert.ok(row);
  assert.equal(row.registry_status, "registered");
  assert.equal(row.lifecycle_status, "registered");
  assert.ok(row.registered_at);
  assert.equal(row.label, "Kapı 1");
});

test("registerDevice: promotes a quarantined device to registered", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await upsertDevice(p(), baseUpsert("SN-REG-2", true));
  await registerDevice(p(), { sn: "SN-REG-2", label: "Onaylandı" });
  const row = await getDeviceRegistry(p(), "SN-REG-2");
  assert.ok(row);
  assert.equal(row.registry_status, "registered");
  assert.equal(row.label, "Onaylandı");
});

test("registerDevice: partial updates merge via COALESCE", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await registerDevice(p(), { sn: "SN-REG-3", label: "L1" });
  await registerDevice(p(), { sn: "SN-REG-3", city: "İstanbul" });
  const row = await getDeviceRegistry(p(), "SN-REG-3");
  assert.ok(row);
  assert.equal(row.label, "L1", "earlier label preserved");
  assert.equal(row.city, "İstanbul");
});

test("registerDevice: links customer + property type and joins them back", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const customer = await createCustomer(p(), { name: "Ahmet Yılmaz", phone: "555" });
  const pt = await createPropertyType(p(), { code: "regtest_yurt", label: "Yurt", sortOrder: 5 });
  await registerDevice(p(), { sn: "SN-REG-4", customerId: customer.id, propertyTypeId: pt.id });
  const row = await getDeviceRegistry(p(), "SN-REG-4");
  assert.ok(row);
  assert.equal(row.customer_id, customer.id);
  assert.equal(row.customer_name, "Ahmet Yılmaz");
  assert.equal(row.property_type_code, "regtest_yurt");
  assert.equal(row.property_type_label, "Yurt");
});

// ---------------------------------------------------------------------------
// bulkRegisterDevices
// ---------------------------------------------------------------------------

test("bulkRegisterDevices: counts ok rows and flags missing SN", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const res = await bulkRegisterDevices(p(), [
    { sn: "SN-BULK-1", label: "A" },
    { sn: "   ", label: "no sn" },
    { sn: "SN-BULK-2", label: "B" }
  ]);
  assert.equal(res.total, 3);
  assert.equal(res.ok, 2);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0]?.error, "missing_sn");
  assert.ok(await getDeviceRegistry(p(), "SN-BULK-1"));
  assert.ok(await getDeviceRegistry(p(), "SN-BULK-2"));
});

test("bulkRegisterDevices: duplicate SN within a batch upserts (last write wins)", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const res = await bulkRegisterDevices(p(), [
    { sn: "SN-DUP", label: "first" },
    { sn: "SN-DUP", city: "Ankara" }
  ]);
  assert.equal(res.ok, 2);
  const row = await getDeviceRegistry(p(), "SN-DUP");
  assert.ok(row);
  assert.equal(row.label, "first");
  assert.equal(row.city, "Ankara");
});

// ---------------------------------------------------------------------------
// listDevicesRegistry / filters
// ---------------------------------------------------------------------------

test("listDevicesRegistry: status filter returns only matching rows", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await registerDevice(p(), { sn: "SN-LIST-REG" });
  await upsertDevice(p(), baseUpsert("SN-LIST-Q", true));
  await upsertDevice(p(), baseUpsert("SN-LIST-AUTO"));

  const quarantined = await listDevicesRegistry(p(), { status: "quarantined" });
  assert.deepEqual(quarantined.map((r) => r.sn), ["SN-LIST-Q"]);

  const registered = await listDevicesRegistry(p(), { status: "registered" });
  assert.deepEqual(registered.map((r) => r.sn), ["SN-LIST-REG"]);
});

test("listDevicesRegistry: search matches sn/label/subscriber/customer (ILIKE)", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  const customer = await createCustomer(p(), { name: "Zeynep Demir" });
  await registerDevice(p(), { sn: "SN-SEARCH-1", label: "Bodrum Kat", customerId: customer.id });
  await registerDevice(p(), { sn: "SN-SEARCH-2", subscriberNo: "ABO-9988" });

  assert.equal((await listDevicesRegistry(p(), { search: "bodrum" })).length, 1);
  assert.equal((await listDevicesRegistry(p(), { search: "zeynep" }))[0]?.sn, "SN-SEARCH-1");
  assert.equal((await listDevicesRegistry(p(), { search: "9988" }))[0]?.sn, "SN-SEARCH-2");
  assert.equal((await listDevicesRegistry(p(), { search: "nomatch" })).length, 0);
});

test("listDevicesRegistry: limit + offset paginate", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  for (let i = 0; i < 5; i += 1) {
    await upsertDevice(p(), { ...baseUpsert(`SN-PAGE-${i}`), lastSeenAt: new Date(Date.UTC(2026, 0, i + 1)) });
  }
  const page1 = await listDevicesRegistry(p(), { limit: 2, offset: 0 });
  const page2 = await listDevicesRegistry(p(), { limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  // ordered by last_seen_at DESC, no overlap between pages
  const overlap = page1.some((r) => page2.find((o) => o.sn === r.sn));
  assert.equal(overlap, false);
});

// ---------------------------------------------------------------------------
// approveQuarantinedDevice / setDeviceLifecycle
// ---------------------------------------------------------------------------

test("approveQuarantinedDevice: promotes once, is idempotent-false afterwards", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await upsertDevice(p(), baseUpsert("SN-APPR-1", true));
  assert.equal(await approveQuarantinedDevice(p(), "SN-APPR-1"), true);
  const row = await getDeviceRegistry(p(), "SN-APPR-1");
  assert.equal(row?.registry_status, "registered");
  // Already registered -> nothing to approve.
  assert.equal(await approveQuarantinedDevice(p(), "SN-APPR-1"), false);
});

test("approveQuarantinedDevice: does not touch an auto device", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await upsertDevice(p(), baseUpsert("SN-APPR-2"));
  assert.equal(await approveQuarantinedDevice(p(), "SN-APPR-2"), false);
  assert.equal((await getDeviceRegistry(p(), "SN-APPR-2"))?.registry_status, "auto");
});

test("setDeviceLifecycle: updates known sn, returns false for unknown", async (t) => {
  if (!dbAvailable) return t.skip(skipReason);
  await registerDevice(p(), { sn: "SN-LC-1" });
  assert.equal(await setDeviceLifecycle(p(), "SN-LC-1", "decommissioned"), true);
  assert.equal((await getDeviceRegistry(p(), "SN-LC-1"))?.lifecycle_status, "decommissioned");
  assert.equal(await setDeviceLifecycle(p(), "SN-MISSING", "active"), false);
});

// ---------------------------------------------------------------------------
// pure helper
// ---------------------------------------------------------------------------

test("isManagedRegistryStatus: only registered/auto are managed", () => {
  assert.equal(isManagedRegistryStatus("registered"), true);
  assert.equal(isManagedRegistryStatus("auto"), true);
  assert.equal(isManagedRegistryStatus("quarantined"), false);
  assert.equal(isManagedRegistryStatus(null), false);
  assert.equal(isManagedRegistryStatus(undefined), false);
});
