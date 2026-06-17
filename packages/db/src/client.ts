import { Pool, type PoolConfig } from "pg";

export interface DbConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Max pooled connections. Default 10 is too small for a worker that fans out inbound
   * processing + publish + reconcile + timeout sweeps concurrently at scale. */
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export const createDbPool = (config: DbConnectionConfig): Pool => {
  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    // Surface pool exhaustion as a fast error instead of hanging forever when all connections
    // are checked out (e.g. an inbound burst), so callers can log/retry rather than stall silently.
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000
  };

  const pool = new Pool(poolConfig);
  // CRITICAL: pg emits 'error' on idle pooled clients whose socket drops (network/DB blip, server
  // restart). With no listener, Node treats it as an unhandled 'error' event and CRASHES the whole
  // process. A long-running worker must survive transient DB blips: log and let the pool recycle the
  // dead connection; subsequent queries reconnect.
  pool.on("error", (err) => {
    console.error("[db] idle pool client error (recovered)", {
      message: err instanceof Error ? err.message : String(err)
    });
  });
  return pool;
};
