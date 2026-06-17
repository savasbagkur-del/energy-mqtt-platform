import type { Pool } from "pg";

/**
 * Runs `fn` only if a Postgres session-level advisory lock for `key` is acquired; otherwise returns
 * `{ ran: false }` immediately. Used to make global bookkeeping sweeps (command timeout/expiry)
 * single-flight across multiple worker instances, while parallel paths (publish claim, reconciler
 * lease) keep distributing load. The lock is held on a dedicated pooled connection for the duration
 * of `fn` and released afterwards.
 */
export const tryWithAdvisoryLock = async <T>(
  pool: Pool,
  key: number,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> => {
  const client = await pool.connect();
  let acquired = false;
  try {
    const res = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key]);
    acquired = res.rows[0]?.ok === true;
    if (!acquired) {
      return { ran: false };
    }
    const result = await fn();
    return { ran: true, result };
  } finally {
    if (acquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [key]);
      } catch {
        // unlock best-effort; session end releases it anyway
      }
    }
    client.release();
  }
};

/** Stable advisory-lock keys (avoid collisions across subsystems). */
export const ADVISORY_LOCK_KEYS = {
  commandTimeoutSweep: 880421
} as const;
