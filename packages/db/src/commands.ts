import type { Pool } from "pg";
import type {
  CommandEventRow,
  CommandRow,
  CommandStatus,
  CommandType,
  CommandWithEvents
} from "./types.js";
import { getEffectivePolicyForDevice } from "./policies.js";

export interface CreateCommandInput {
  sn: string;
  productKey: string;
  commandType: CommandType;
  method: string;
  msgid: string;
  parentCommandId?: string;
  requestPayload: unknown;
  priority?: number;
  scheduledAt?: Date;
  expiresAt?: Date;
  policySnapshot?: unknown;
}

export const createCommand = async (
  pool: Pool,
  input: CreateCommandInput
): Promise<CommandRow> => {
  const now = new Date();
  const policySnapshot =
    input.policySnapshot ??
    (await getEffectivePolicyForDevice(pool, {
      sn: input.sn,
      productKey: input.productKey,
      commandType: input.commandType
    })).profile;

  const result = await pool.query<CommandRow>(
    `INSERT INTO commands (
      sn, product_key, command_type, method, msgid, parent_command_id, status,
      priority, attempt_count, next_attempt_at, expires_at, request_payload, policy_snapshot
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
    RETURNING *`,
    [
      input.sn,
      input.productKey,
      input.commandType,
      input.method,
      input.msgid,
      input.parentCommandId ?? null,
      "scheduled",
      input.priority ?? 100,
      0,
      input.scheduledAt ?? now,
      input.expiresAt ?? null,
      JSON.stringify(input.requestPayload),
      JSON.stringify(policySnapshot)
    ]
  );
  const created = result.rows[0];
  if (!created) {
    throw new Error("failed to create command");
  }
  return created;
};

export const addCommandEvent = async (
  pool: Pool,
  commandId: string,
  eventType: string,
  payload: unknown = null
): Promise<void> => {
  await pool.query(
    `INSERT INTO command_events (command_id, event_type, payload)
     VALUES ($1,$2,$3::jsonb)`,
    [commandId, eventType, payload == null ? null : JSON.stringify(payload)]
  );
};

/**
 * Terminal transition for scheduled/created commands whose TTL has passed.
 * Without this, claimCommandsForPublish never selects them (expires_at > NOW()) and they stay stuck in scheduled.
 */
export const expireStaleScheduledCommands = async (pool: Pool): Promise<CommandRow[]> => {
  const result = await pool.query<CommandRow>(
    `UPDATE commands
     SET status = 'expired',
         completed_at = NOW(),
         updated_at = NOW()
     WHERE status IN ('scheduled', 'created')
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
     RETURNING *`
  );
  for (const row of result.rows) {
    await addCommandEvent(pool, row.id, "expired", {
      reason: "command_ttl_elapsed_before_publish"
    });
  }
  return result.rows;
};

/**
 * Claims scheduled commands for publish. Per-device single-flight: only the earliest eligible row
 * per `sn` is claimed while another command for the same `sn` is in the publish/ack/verify pipeline,
 * unless `policy_snapshot.single_flight_enabled` is false.
 */
export interface ClaimPublishOptions {
  /** Restrict the claim to a single device (used by wake-triggered per-sn flush). */
  sn?: string | null;
  /**
   * Presence gating: only claim commands for devices whose last telemetry is within this many
   * seconds (i.e. currently awake). Avoids burning sends/retries on sleepy/offline devices whose
   * QoS1 messages would be dropped. 0/undefined disables gating.
   */
  requireRecentTelemetrySec?: number | null;
  /**
   * Per-device adaptive presence gating (Faz C). For devices with a learned reconnect cadence, the
   * window is `clamp(ewma_reconnect_sec * fraction, floorSec, capSec)` — auto-tuned per device with
   * no manual knob. Devices WITHOUT a learned cadence are not constrained by this clause (wake-flush
   * still delivers; cadence kicks in after a few logins).
   */
  adaptiveGating?: {
    fraction: number;
    floorSec: number;
    capSec: number;
    minSamples: number;
  } | null;
}

/** Shared claimability WHERE fragments + bound params (mirrored by countClaimableForPublish). */
const buildClaimableFilters = (
  opts: ClaimPublishOptions,
  params: unknown[]
): string => {
  let sql = "";
  if (opts.sn) {
    params.push(opts.sn);
    sql += `\n         AND c.sn = $${params.length}`;
  }
  if (opts.requireRecentTelemetrySec && opts.requireRecentTelemetrySec > 0) {
    params.push(opts.requireRecentTelemetrySec);
    sql += `\n         AND EXISTS (
           SELECT 1 FROM device_latest_state d
           WHERE d.sn = c.sn
             AND d.last_seen_at IS NOT NULL
             AND d.last_seen_at > NOW() - ($${params.length} * interval '1 second')
         )`;
  }
  if (opts.adaptiveGating) {
    params.push(opts.adaptiveGating.fraction);
    const pFraction = params.length;
    params.push(opts.adaptiveGating.floorSec);
    const pFloor = params.length;
    params.push(opts.adaptiveGating.capSec);
    const pCap = params.length;
    params.push(opts.adaptiveGating.minSamples);
    const pMin = params.length;
    sql += `\n         AND (
           NOT EXISTS (
             SELECT 1 FROM device_cadence_stats dc
             WHERE dc.sn = c.sn
               AND dc.ewma_reconnect_sec IS NOT NULL
               AND dc.sample_count >= $${pMin}
           )
           OR EXISTS (
             SELECT 1 FROM device_latest_state d
             JOIN device_cadence_stats dc ON dc.sn = d.sn
             WHERE d.sn = c.sn
               AND d.last_seen_at IS NOT NULL
               AND dc.sample_count >= $${pMin}
               AND d.last_seen_at > NOW() - (
                 LEAST($${pCap}, GREATEST($${pFloor}, dc.ewma_reconnect_sec * $${pFraction})) * interval '1 second'
               )
           )
         )`;
  }
  return sql;
};

export const claimCommandsForPublish = async (
  pool: Pool,
  limit = 20,
  opts: ClaimPublishOptions = {}
): Promise<CommandRow[]> => {
  const client = await pool.connect();
  const params: unknown[] = [limit];
  const extraFilters = buildClaimableFilters(opts, params);
  try {
    await client.query("BEGIN");
    // IMPORTANT: claimability filters (first-per-sn ordering + single-flight) MUST be applied
    // BEFORE the LIMIT, otherwise a small set of blocked head-of-line rows (e.g. sns that already
    // have an in-flight command) starves the whole pipeline and the claim returns zero while
    // hundreds of other sns remain eligible. Filtering inside the locked candidate set keeps the
    // LIMIT focused on rows that are actually claimable.
    const selected = await client.query<CommandRow>(
      `SELECT c.*
       FROM commands c
       WHERE c.status IN ('created', 'scheduled')
         AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= NOW())
         AND (c.expires_at IS NULL OR c.expires_at > NOW())${extraFilters}
         AND NOT EXISTS (
           SELECT 1
           FROM commands o
           WHERE o.sn = c.sn
             AND o.id <> c.id
             AND o.status IN ('created', 'scheduled')
             AND (o.expires_at IS NULL OR o.expires_at > NOW())
             AND (
               o.priority < c.priority
               OR (o.priority = c.priority AND o.created_at < c.created_at)
               OR (o.priority = c.priority AND o.created_at = c.created_at AND o.id < c.id)
             )
         )
         AND (
           COALESCE((c.policy_snapshot->>'single_flight_enabled')::boolean, TRUE) IS FALSE
           OR NOT EXISTS (
             SELECT 1
             FROM commands x
             WHERE x.sn = c.sn
               AND x.id <> c.id
               AND x.status IN ('published', 'ack_received', 'verify_pending')
               AND (x.expires_at IS NULL OR x.expires_at > NOW())
           )
         )
       ORDER BY c.priority ASC, c.created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      params
    );
    const ids = selected.rows.map((row) => row.id);
    if (ids.length > 0) {
      const updated = await client.query<CommandRow>(
        `UPDATE commands
         SET status = 'published',
             attempt_count = attempt_count + 1,
             published_at = NOW(),
             delivery_window_anchor_at = COALESCE(delivery_window_anchor_at, NOW()),
             updated_at = NOW()
         WHERE id = ANY($1::bigint[])
         RETURNING *`,
        [ids]
      );
      await client.query("COMMIT");
      return updated.rows;
    }
    await client.query("COMMIT");
    return [];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Counts commands that are genuinely claimable for publish RIGHT NOW (mirrors the filter in
 * `claimCommandsForPublish` minus LIMIT / row locks). Use this for "dispatcher stuck" diagnostics
 * so we do NOT false-alarm on commands that are legitimately waiting behind an in-flight command
 * for the same sn (single-flight) or behind an older queued command for the same sn.
 */
export const countClaimableForPublish = async (
  pool: Pool,
  opts: ClaimPublishOptions = {}
): Promise<number> => {
  const params: unknown[] = [];
  const extraFilters = buildClaimableFilters(opts, params);
  const result = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::bigint AS c
     FROM commands c
     WHERE c.status IN ('created', 'scheduled')
       AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= NOW())
       AND (c.expires_at IS NULL OR c.expires_at > NOW())${extraFilters}
       AND NOT EXISTS (
         SELECT 1
         FROM commands o
         WHERE o.sn = c.sn
           AND o.id <> c.id
           AND o.status IN ('created', 'scheduled')
           AND (o.expires_at IS NULL OR o.expires_at > NOW())
           AND (
             o.priority < c.priority
             OR (o.priority = c.priority AND o.created_at < c.created_at)
             OR (o.priority = c.priority AND o.created_at = c.created_at AND o.id < c.id)
           )
       )
       AND (
         COALESCE((c.policy_snapshot->>'single_flight_enabled')::boolean, TRUE) IS FALSE
         OR NOT EXISTS (
           SELECT 1
           FROM commands x
           WHERE x.sn = c.sn
             AND x.id <> c.id
             AND x.status IN ('published', 'ack_received', 'verify_pending')
             AND (x.expires_at IS NULL OR x.expires_at > NOW())
         )
       )`,
    params
  );
  return Number(result.rows[0]?.c ?? 0);
};

export const updateCommandStatus = async (
  pool: Pool,
  commandId: string,
  status: CommandStatus,
  options?: {
    ackPayload?: unknown;
    verificationPayload?: unknown;
    errorMessage?: string | null;
    nextAttemptAt?: Date | null;
    completedAt?: Date | null;
  }
): Promise<void> => {
  const ackPayload = options?.ackPayload;
  const verificationPayload = options?.verificationPayload;
  const errorMessage = options?.errorMessage ?? null;
  const nextAttemptAt = options?.nextAttemptAt ?? null;
  const completedAt = options?.completedAt ?? null;

  await pool.query(
    `UPDATE commands SET
      status = $2,
      ack_payload = COALESCE($3::jsonb, ack_payload),
      verification_payload = COALESCE($4::jsonb, verification_payload),
      error_message = COALESCE($5, error_message),
      next_attempt_at = COALESCE($6, next_attempt_at),
      published_at = CASE WHEN $2 = 'published' THEN NOW() ELSE published_at END,
      ack_at = CASE WHEN $2 = 'ack_received' THEN NOW() ELSE ack_at END,
      verified_at = CASE WHEN $2 IN ('verified_success', 'verified_success_with_late_confirmation', 'verified_mismatch', 'verified_failed', 'verification_failed') THEN NOW() ELSE verified_at END,
      completed_at = COALESCE($7,
        CASE WHEN $2 IN ('verified_success', 'verified_success_with_late_confirmation', 'verified_mismatch', 'delivery_timeout', 'expired', 'cancelled', 'failed', 'verified_failed', 'verification_failed')
             THEN NOW()
             ELSE completed_at
        END
      ),
      updated_at = NOW()
    WHERE id = $1`,
    [
      commandId,
      status,
      ackPayload == null ? null : JSON.stringify(ackPayload),
      verificationPayload == null ? null : JSON.stringify(verificationPayload),
      errorMessage,
      nextAttemptAt,
      completedAt
    ]
  );
};

const MIN_MSGID_PREFIX_LEN = 8;

/**
 * Match published command by ACK msgid. Exact first; then prefix (truncated/corrupt echo);
 * then digits-only vs stored numeric msgid.
 */
export const findCommandForAck = async (
  pool: Pool,
  sn: string,
  msgid: string,
  method: string
): Promise<CommandRow | null> => {
  const trimmed = msgid.trim();

  const exact = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND msgid = $2
       AND method = $3
       AND status IN ('published')
     ORDER BY created_at DESC
     LIMIT 1`,
    [sn, trimmed, method]
  );
  if (exact.rows[0]) {
    return exact.rows[0];
  }

  if (trimmed.length >= MIN_MSGID_PREFIX_LEN) {
    const prefix = await pool.query<CommandRow>(
      `SELECT * FROM commands
       WHERE sn = $1
         AND method = $2
         AND status IN ('published')
         AND char_length(msgid) >= $4
         AND char_length($3) >= $4
         AND (msgid LIKE $3 || '%' OR $3 LIKE msgid || '%')
       ORDER BY created_at DESC
       LIMIT 1`,
      [sn, method, trimmed, MIN_MSGID_PREFIX_LEN]
    );
    if (prefix.rows[0]) {
      return prefix.rows[0];
    }
  }

  const digitsOnly = trimmed.replace(/\D/g, "");
  if (
    digitsOnly.length >= MIN_MSGID_PREFIX_LEN &&
    digitsOnly !== trimmed
  ) {
    const digitMatch = await pool.query<CommandRow>(
      `SELECT * FROM commands
       WHERE sn = $1
         AND method = $2
         AND status IN ('published')
         AND msgid ~ '^[0-9]+$'
         AND char_length(msgid) >= $4
         AND char_length($3) >= $4
         AND (msgid LIKE $3 || '%' OR $3 LIKE msgid || '%')
       ORDER BY created_at DESC
       LIMIT 1`,
      [sn, method, digitsOnly, MIN_MSGID_PREFIX_LEN]
    );
    if (digitMatch.rows[0]) {
      return digitMatch.rows[0];
    }
  }

  return null;
};

/**
 * Same sn/msgid/method as a command already past publish (duplicate indicate/dev ACK).
 */
export const findCommandDuplicateInboundAck = async (
  pool: Pool,
  sn: string,
  msgid: string,
  method: string
): Promise<CommandRow | null> => {
  const trimmed = msgid.trim();
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND msgid = $2
       AND method = $3
       AND status IN (
         'ack_received',
         'verify_pending',
         'verified_success',
         'verified_success_with_late_confirmation',
         'verified_mismatch'
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [sn, trimmed, method]
  );
  return result.rows[0] ?? null;
};

export const findRefreshWaitingVerification = async (
  pool: Pool,
  sn: string
): Promise<CommandRow | null> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND command_type = 'refresh'
       AND status IN ('ack_received', 'verify_pending')
     ORDER BY updated_at DESC
     LIMIT 1`,
    [sn]
  );
  return result.rows[0] ?? null;
};

export const listRefreshCommandsWaitingVerification = async (
  pool: Pool,
  sn: string
): Promise<CommandRow[]> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND command_type = 'refresh'
       AND status IN ('ack_received', 'verify_pending')
     ORDER BY updated_at ASC`,
    [sn]
  );
  return result.rows;
};

export const listChildCommands = async (
  pool: Pool,
  parentCommandId: string
): Promise<CommandRow[]> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE parent_command_id = $1
     ORDER BY created_at ASC`,
    [parentCommandId]
  );
  return result.rows;
};

export const findLatestVerifiedChildRefresh = async (
  pool: Pool,
  parentCommandId: string
): Promise<CommandRow | null> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE parent_command_id = $1
       AND command_type = 'refresh'
       AND status = 'verified_success'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [parentCommandId]
  );
  return result.rows[0] ?? null;
};

export const findSwitchCommandsWaitingVerification = async (
  pool: Pool,
  sn: string
): Promise<CommandRow[]> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND command_type IN ('force_switch_0', 'force_switch_1')
       AND status IN ('ack_received', 'verify_pending')
     ORDER BY updated_at DESC`,
    [sn]
  );
  return result.rows;
};

export const getCommandById = async (
  pool: Pool,
  id: string
): Promise<CommandRow | null> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
};

export const listCommandEvents = async (
  pool: Pool,
  commandId: string
): Promise<CommandEventRow[]> => {
  const result = await pool.query<CommandEventRow>(
    `SELECT * FROM command_events
     WHERE command_id = $1
     ORDER BY created_at ASC`,
    [commandId]
  );
  return result.rows;
};

export const getCommandWithEvents = async (
  pool: Pool,
  id: string
): Promise<CommandWithEvents | null> => {
  const command = await getCommandById(pool, id);
  if (!command) {
    return null;
  }
  const events = await listCommandEvents(pool, id);
  const children = await listChildCommands(pool, id);
  return { command, events, children };
};

export const listCommandsBySn = async (pool: Pool, sn: string, limit = 100): Promise<CommandRow[]> => {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sn, safeLimit]
  );
  return result.rows;
};

export const getActiveSwitchCommandForDevice = async (
  pool: Pool,
  sn: string
): Promise<CommandRow | null> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND command_type IN ('force_switch_0', 'force_switch_1')
       AND status IN ('scheduled', 'published', 'ack_received', 'verify_pending')
     ORDER BY created_at DESC
     LIMIT 1`,
    [sn]
  );
  return result.rows[0] ?? null;
};

/** Single-flight: any non-terminal command still in the publish/ack/verify pipeline for this device. */
export const getInFlightCommandForDevice = async (
  pool: Pool,
  sn: string
): Promise<CommandRow | null> => {
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND status IN ('created', 'scheduled', 'published', 'ack_received', 'verify_pending')
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT 1`,
    [sn]
  );
  return result.rows[0] ?? null;
};

/** Published commands whose ACK window has elapsed (worker-driven `ackTimeoutSec`, field tuning). */
/** Uses per-command `policy_snapshot.ack_timeout_sec` when set; else `defaultAckTimeoutSec`. */
export const listPublishedCommandsPastAckDeadline = async (
  pool: Pool,
  defaultAckTimeoutSec: number
): Promise<CommandRow[]> => {
  const fallback = Math.max(1, Math.floor(defaultAckTimeoutSec));
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE status = 'published'
       AND published_at IS NOT NULL
       AND published_at
           + (
             GREATEST(
               1,
               COALESCE(
                 NULLIF((policy_snapshot->>'ack_timeout_sec')::int, 0),
                 $1::int
               )
             ) * interval '1 second'
           )
           < NOW()
     ORDER BY published_at ASC`,
    [fallback]
  );
  return result.rows;
};

/**
 * Refresh commands (standalone + child) still waiting on verify past `verifyTimeoutSec` since ack_at.
 */
export const listRefreshCommandsPastVerifyDeadline = async (
  pool: Pool,
  defaultVerifyTimeoutSec: number
): Promise<CommandRow[]> => {
  const fallback = Math.max(1, Math.floor(defaultVerifyTimeoutSec));
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE command_type = 'refresh'
       AND status IN ('ack_received', 'verify_pending')
       AND ack_at IS NOT NULL
       AND ack_at
           + (
             GREATEST(
               1,
               COALESCE(NULLIF((policy_snapshot->>'verify_timeout_sec')::int, 0), $1::int),
               COALESCE(NULLIF((policy_snapshot->>'telemetry_cycle_sec')::int, 0), 0)
             ) * interval '1 second'
           )
           < NOW()
     ORDER BY ack_at ASC`,
    [fallback]
  );
  return result.rows;
};

/**
 * Switch parents in verify_pending past verify timeout since switch ACK (waiting on child verify).
 */
export const listSwitchParentsPastVerifyDeadline = async (
  pool: Pool,
  defaultVerifyTimeoutSec: number
): Promise<CommandRow[]> => {
  const fallback = Math.max(1, Math.floor(defaultVerifyTimeoutSec));
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE command_type IN ('force_switch_0', 'force_switch_1')
       AND status = 'verify_pending'
       AND ack_at IS NOT NULL
       AND ack_at
           + (
             GREATEST(
               1,
               COALESCE(NULLIF((policy_snapshot->>'verify_timeout_sec')::int, 0), $1::int),
               COALESCE(NULLIF((policy_snapshot->>'telemetry_cycle_sec')::int, 0), 0)
             ) * interval '1 second'
           )
           < NOW()
     ORDER BY ack_at ASC`,
    [fallback]
  );
  return result.rows;
};

/** Switch parents stuck in delivery_timeout but still eligible for telemetry-based late confirmation. */
export const listSwitchParentsForLateConfirmation = async (
  pool: Pool,
  sn: string,
  defaultLateWindowSec: number
): Promise<CommandRow[]> => {
  const fallback = Math.max(60, Math.floor(defaultLateWindowSec));
  const result = await pool.query<CommandRow>(
    `SELECT * FROM commands
     WHERE sn = $1
       AND command_type IN ('force_switch_0', 'force_switch_1')
       AND status = 'delivery_timeout'
       AND completed_at IS NOT NULL
       AND completed_at + (
         GREATEST(
           60,
           COALESCE(
             NULLIF((policy_snapshot->>'late_confirmation_window_sec')::int, 0),
             $2::int
           )
         ) * interval '1 second'
       ) > NOW()
     ORDER BY completed_at DESC`,
    [sn, fallback]
  );
  return result.rows;
};

export const countCommandsInWindow = async (
  pool: Pool,
  sn: string,
  commandType: CommandType,
  windowHours: number
): Promise<number> => {
  const wh = Math.max(1 / 60, windowHours);
  const result = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::bigint AS c
     FROM commands
     WHERE sn = $1
       AND command_type = $2
       AND created_at > NOW() - ($3::float * interval '1 hour')
       AND status NOT IN ('expired', 'cancelled')`,
    [sn, commandType, wh]
  );
  return Number(result.rows[0]?.c ?? 0);
};

export const countSwitchCommandsInWindow = async (
  pool: Pool,
  sn: string,
  windowHours: number
): Promise<number> => {
  const wh = Math.max(1 / 60, windowHours);
  const result = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::bigint AS c
     FROM commands
     WHERE sn = $1
       AND command_type IN ('force_switch_0', 'force_switch_1')
       AND created_at > NOW() - ($2::float * interval '1 hour')
       AND status NOT IN ('expired', 'cancelled')`,
    [sn, wh]
  );
  return Number(result.rows[0]?.c ?? 0);
};

/**
 * Cancel all non-terminal switch commands for a device (used on supersede / desired cancel).
 * Returns cancelled command ids.
 */
export const cancelInFlightForDevice = async (
  pool: Pool,
  sn: string,
  reason: string = "cancelled by reconciler"
): Promise<string[]> => {
  const result = await pool.query<{ id: string }>(
    `UPDATE commands
     SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(),
         error_message = COALESCE(error_message, $2)
     WHERE sn = $1
       AND command_type IN ('force_switch_0', 'force_switch_1')
       AND status IN ('created', 'scheduled', 'published', 'ack_received', 'verify_pending')
     RETURNING id`,
    [sn, reason]
  );
  return result.rows.map((r) => r.id);
};

/** Stamps the row after a confirmed MQTT publish (observability + outbox bridge). */
export const markCommandPublishAttempt = async (
  pool: Pool,
  commandId: string
): Promise<void> => {
  await pool.query(
    `UPDATE commands SET last_publish_attempt_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [commandId]
  );
};

export const rescheduleCommandAfterAckTimeout = async (
  pool: Pool,
  commandId: string,
  nextAttemptAt: Date
): Promise<void> => {
  await pool.query(
    `UPDATE commands SET
       status = 'scheduled',
       next_attempt_at = $2,
       published_at = NULL,
       updated_at = NOW()
     WHERE id = $1`,
    [commandId, nextAttemptAt]
  );
};
