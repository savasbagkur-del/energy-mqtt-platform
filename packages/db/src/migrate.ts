import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appConfig } from "@communication/core";
import { createDbPool } from "./client.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const migrationsDir = join(currentDir, "../migrations");

const run = async (): Promise<void> => {
  const host = appConfig.postgresHost ?? "127.0.0.1";
  const port = appConfig.postgresPort ?? 5433;
  const database = appConfig.postgresDb ?? "communication";
  const user = appConfig.postgresUser ?? "postgres";
  const password = appConfig.postgresPassword ?? "postgres";

  const pool = createDbPool({ host, port, database, user, password });
  console.log("[db:migrate] starting", { host, port, database, user });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const check = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations WHERE id = $1",
      [file]
    );
    if (check.rowCount && check.rowCount > 0) {
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      console.log("[db:migrate] applied", { file });
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  await pool.end();
  console.log("[db:migrate] completed");
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown migration error";
  console.error("[db:migrate] failed", { message });
  process.exitCode = 1;
});
