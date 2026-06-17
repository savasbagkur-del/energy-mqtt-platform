import type { Pool } from "pg";
import type { DatabaseError } from "pg";
import type {
  CommandPolicyProfileRow,
  CommandType,
  DeviceCommandPolicyOverrideRow,
  DeviceCommandPolicyView
} from "./types.js";
import { applyCadenceToPolicy, getDeviceCadence } from "./device-cadence.js";

/** Faz C adaptive-timing default; disable with ADAPTIVE_TIMING_ENABLED=false. */
const adaptiveTimingEnabledFromEnv = (): boolean => {
  const raw = (process.env.ADAPTIVE_TIMING_ENABLED ?? "").trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "no" || raw === "off");
};

export interface CreatePolicyProfileInput {
  code: string;
  name: string;
  isDefault?: boolean;
  enabled?: boolean;
  ackTimeoutSec: number;
  verifyTimeoutSec: number;
  commandTtlSec: number;
  quickRetrySeconds: number[];
  slowRetrySeconds: number[];
  verifyRefreshDelaysSec: number[];
  refreshBudgetPerHour: number;
  diagnosticsIntervalMs: number;
  diagnosticsDurationSec: number;
  maxAttempts: number;
  ackRetryMinDelaySec?: number;
  telemetryCycleSec?: number;
  lateConfirmationWindowSec?: number;
  switchBudgetPerHour?: number;
  singleFlightEnabled?: boolean;
  deviceBusyMode?: string;
  retryBackoffMode?: string;
  retryJitterPct?: number;
  autoRefreshAfterSwitchEnabled?: boolean;
  autoRefreshDelaySec?: number;
  parentFinalizeFromChildRefresh?: boolean;
  parentLateSuccessEnabled?: boolean;
  retryIntervalSec?: number;
  deliveryWindowSec?: number;
  raiseCommunicationFaultEnabled?: boolean;
  faultIfOnlineButNoAckAfterSec?: number | null;
  faultIfOnlineButNoVerifyAfterSec?: number | null;
}

export interface UpdatePolicyProfileInput {
  name?: string;
  enabled?: boolean;
  isDefault?: boolean;
  ackTimeoutSec?: number;
  verifyTimeoutSec?: number;
  commandTtlSec?: number;
  quickRetrySeconds?: number[];
  slowRetrySeconds?: number[];
  verifyRefreshDelaysSec?: number[];
  refreshBudgetPerHour?: number;
  diagnosticsIntervalMs?: number;
  diagnosticsDurationSec?: number;
  maxAttempts?: number;
  ackRetryMinDelaySec?: number;
  telemetryCycleSec?: number;
  lateConfirmationWindowSec?: number;
  switchBudgetPerHour?: number;
  singleFlightEnabled?: boolean;
  deviceBusyMode?: string;
  retryBackoffMode?: string;
  retryJitterPct?: number;
  autoRefreshAfterSwitchEnabled?: boolean;
  autoRefreshDelaySec?: number;
  parentFinalizeFromChildRefresh?: boolean;
  parentLateSuccessEnabled?: boolean;
  retryIntervalSec?: number;
  deliveryWindowSec?: number;
  raiseCommunicationFaultEnabled?: boolean;
  faultIfOnlineButNoAckAfterSec?: number | null;
  faultIfOnlineButNoVerifyAfterSec?: number | null;
}

/** Resolution order for maintenance docs (override wins over default profile). */
export const POLICY_RESOLUTION_ORDER = [
  "device_command_policy_override (sn + command_type + product_key — most specific match)",
  "device_command_policy_override (sn + product_key)",
  "device_command_policy_override (sn only)",
  "command_policy_profiles where is_default = true"
] as const;

/** Flat view for maintenance / UI (backend contract); values mirror DB profile columns. */
export const describeEffectiveCommandOrchestration = (
  row: CommandPolicyProfileRow
): Record<string, unknown> => {
  const verifyTimeoutSec = row.verify_timeout_sec;
  const telemetryCycleSec = row.telemetry_cycle_sec ?? 300;
  return {
    ackTimeoutSec: row.ack_timeout_sec,
    verifyTimeoutSec,
    commandTtlSec: row.command_ttl_sec,
    maxAttempts: row.max_attempts,
    quickRetrySeconds: row.quick_retry_seconds,
    slowRetrySeconds: row.slow_retry_seconds,
    verifyRefreshDelaysSec: row.verify_refresh_delays_sec,
    refreshBudgetPerHour: row.refresh_budget_per_hour,
    switchBudgetPerHour: row.switch_budget_per_hour ?? 48,
    diagnosticsIntervalMs: row.diagnostics_interval_ms,
    diagnosticsDurationSec: row.diagnostics_duration_sec,
    ackRetryMinDelaySec: row.ack_retry_min_delay_sec ?? 5,
    telemetryCycleSec,
    lateConfirmationWindowSec: row.late_confirmation_window_sec ?? 3600,
    effectiveVerifyWaitSec: Math.max(verifyTimeoutSec, telemetryCycleSec),
    singleFlightEnabled: row.single_flight_enabled ?? true,
    deviceBusyMode: row.device_busy_mode ?? "reject",
    retryBackoffMode: row.retry_backoff_mode ?? "fixed",
    retryJitterPct: row.retry_jitter_pct ?? 20,
    autoRefreshAfterSwitchEnabled: row.auto_refresh_after_switch_enabled ?? true,
    autoRefreshDelaySec: row.auto_refresh_delay_sec ?? 0,
    parentFinalizeFromChildRefresh: row.parent_finalize_from_child_refresh ?? true,
    parentLateSuccessEnabled: row.parent_late_success_enabled ?? true,
    retryIntervalSec: row.retry_interval_sec ?? 30,
    deliveryWindowSec: row.delivery_window_sec ?? 720,
    raiseCommunicationFaultEnabled: row.raise_communication_fault_enabled ?? false,
    faultIfOnlineButNoAckAfterSec: row.fault_if_online_but_no_ack_after_sec ?? null,
    faultIfOnlineButNoVerifyAfterSec: row.fault_if_online_but_no_verify_after_sec ?? null
  };
};

export const listCommandPolicyProfiles = async (pool: Pool): Promise<CommandPolicyProfileRow[]> => {
  const result = await pool.query<CommandPolicyProfileRow>(
    `SELECT * FROM command_policy_profiles
     ORDER BY is_default DESC, code ASC`
  );
  return result.rows;
};

export const createCommandPolicyProfile = async (
  pool: Pool,
  input: CreatePolicyProfileInput
): Promise<CommandPolicyProfileRow> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault) {
      await client.query(`UPDATE command_policy_profiles SET is_default = FALSE WHERE is_default = TRUE`);
    }
    const result = await client.query<CommandPolicyProfileRow>(
      `INSERT INTO command_policy_profiles (
        code, name, is_default, enabled,
        ack_timeout_sec, verify_timeout_sec, command_ttl_sec,
        quick_retry_seconds, slow_retry_seconds, verify_refresh_delays_sec,
        refresh_budget_per_hour, diagnostics_interval_ms, diagnostics_duration_sec, max_attempts,
        ack_retry_min_delay_sec, telemetry_cycle_sec, late_confirmation_window_sec, switch_budget_per_hour,
        single_flight_enabled, device_busy_mode, retry_backoff_mode, retry_jitter_pct,
        auto_refresh_after_switch_enabled, auto_refresh_delay_sec, parent_finalize_from_child_refresh, parent_late_success_enabled,
        retry_interval_sec, delivery_window_sec, raise_communication_fault_enabled,
        fault_if_online_but_no_ack_after_sec, fault_if_online_but_no_verify_after_sec
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
      )
      RETURNING *`,
      [
        input.code,
        input.name,
        input.isDefault ?? false,
        input.enabled ?? true,
        input.ackTimeoutSec,
        input.verifyTimeoutSec,
        input.commandTtlSec,
        JSON.stringify(input.quickRetrySeconds),
        JSON.stringify(input.slowRetrySeconds),
        JSON.stringify(input.verifyRefreshDelaysSec),
        input.refreshBudgetPerHour,
        input.diagnosticsIntervalMs,
        input.diagnosticsDurationSec,
        input.maxAttempts,
        input.ackRetryMinDelaySec ?? 5,
        input.telemetryCycleSec ?? 300,
        input.lateConfirmationWindowSec ?? 3600,
        input.switchBudgetPerHour ?? 48,
        input.singleFlightEnabled ?? true,
        input.deviceBusyMode ?? "reject",
        input.retryBackoffMode ?? "fixed",
        input.retryJitterPct ?? 20,
        input.autoRefreshAfterSwitchEnabled ?? true,
        input.autoRefreshDelaySec ?? 0,
        input.parentFinalizeFromChildRefresh ?? true,
        input.parentLateSuccessEnabled ?? true,
        input.retryIntervalSec ?? 30,
        input.deliveryWindowSec ?? 720,
        input.raiseCommunicationFaultEnabled ?? false,
        input.faultIfOnlineButNoAckAfterSec ?? null,
        input.faultIfOnlineButNoVerifyAfterSec ?? null
      ]
    );
    await client.query("COMMIT");
    const created = result.rows[0];
    if (!created) {
      throw new Error("failed_to_create_policy_profile");
    }
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const updateCommandPolicyProfile = async (
  pool: Pool,
  id: string,
  input: UpdatePolicyProfileInput
): Promise<CommandPolicyProfileRow | null> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault === true) {
      await client.query(`UPDATE command_policy_profiles SET is_default = FALSE WHERE is_default = TRUE`);
    }

    const result = await client.query<CommandPolicyProfileRow>(
      `UPDATE command_policy_profiles SET
        name = COALESCE($2, name),
        enabled = COALESCE($3, enabled),
        is_default = COALESCE($4, is_default),
        ack_timeout_sec = COALESCE($5, ack_timeout_sec),
        verify_timeout_sec = COALESCE($6, verify_timeout_sec),
        command_ttl_sec = COALESCE($7, command_ttl_sec),
        quick_retry_seconds = COALESCE($8::jsonb, quick_retry_seconds),
        slow_retry_seconds = COALESCE($9::jsonb, slow_retry_seconds),
        verify_refresh_delays_sec = COALESCE($10::jsonb, verify_refresh_delays_sec),
        refresh_budget_per_hour = COALESCE($11, refresh_budget_per_hour),
        diagnostics_interval_ms = COALESCE($12, diagnostics_interval_ms),
        diagnostics_duration_sec = COALESCE($13, diagnostics_duration_sec),
        max_attempts = COALESCE($14, max_attempts),
        ack_retry_min_delay_sec = COALESCE($15, ack_retry_min_delay_sec),
        telemetry_cycle_sec = COALESCE($16, telemetry_cycle_sec),
        late_confirmation_window_sec = COALESCE($17, late_confirmation_window_sec),
        switch_budget_per_hour = COALESCE($18, switch_budget_per_hour),
        single_flight_enabled = COALESCE($19, single_flight_enabled),
        device_busy_mode = COALESCE($20, device_busy_mode),
        retry_backoff_mode = COALESCE($21, retry_backoff_mode),
        retry_jitter_pct = COALESCE($22, retry_jitter_pct),
        auto_refresh_after_switch_enabled = COALESCE($23, auto_refresh_after_switch_enabled),
        auto_refresh_delay_sec = COALESCE($24, auto_refresh_delay_sec),
        parent_finalize_from_child_refresh = COALESCE($25, parent_finalize_from_child_refresh),
        parent_late_success_enabled = COALESCE($26, parent_late_success_enabled),
        retry_interval_sec = COALESCE($27, retry_interval_sec),
        delivery_window_sec = COALESCE($28, delivery_window_sec),
        raise_communication_fault_enabled = COALESCE($29, raise_communication_fault_enabled),
        fault_if_online_but_no_ack_after_sec = COALESCE($30, fault_if_online_but_no_ack_after_sec),
        fault_if_online_but_no_verify_after_sec = COALESCE($31, fault_if_online_but_no_verify_after_sec),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [
        id,
        input.name ?? null,
        input.enabled ?? null,
        input.isDefault ?? null,
        input.ackTimeoutSec ?? null,
        input.verifyTimeoutSec ?? null,
        input.commandTtlSec ?? null,
        input.quickRetrySeconds ? JSON.stringify(input.quickRetrySeconds) : null,
        input.slowRetrySeconds ? JSON.stringify(input.slowRetrySeconds) : null,
        input.verifyRefreshDelaysSec ? JSON.stringify(input.verifyRefreshDelaysSec) : null,
        input.refreshBudgetPerHour ?? null,
        input.diagnosticsIntervalMs ?? null,
        input.diagnosticsDurationSec ?? null,
        input.maxAttempts ?? null,
        input.ackRetryMinDelaySec ?? null,
        input.telemetryCycleSec ?? null,
        input.lateConfirmationWindowSec ?? null,
        input.switchBudgetPerHour ?? null,
        input.singleFlightEnabled ?? null,
        input.deviceBusyMode ?? null,
        input.retryBackoffMode ?? null,
        input.retryJitterPct ?? null,
        input.autoRefreshAfterSwitchEnabled ?? null,
        input.autoRefreshDelaySec ?? null,
        input.parentFinalizeFromChildRefresh ?? null,
        input.parentLateSuccessEnabled ?? null,
        input.retryIntervalSec ?? null,
        input.deliveryWindowSec ?? null,
        input.raiseCommunicationFaultEnabled ?? null,
        input.faultIfOnlineButNoAckAfterSec ?? null,
        input.faultIfOnlineButNoVerifyAfterSec ?? null
      ]
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const isPgDatabaseError = (e: unknown): e is DatabaseError =>
  typeof e === "object" &&
  e !== null &&
  "code" in e &&
  typeof (e as DatabaseError).code === "string";

/**
 * Upsert device policy override without relying on INSERT ... ON CONFLICT matching the
 * expression unique index (fragile across PG versions). Uses UPDATE ... IS NOT DISTINCT FROM
 * for nullable product_key / command_type, then INSERT, with SAVEPOINT on unique races.
 */
export const setDeviceCommandPolicyOverride = async (
  pool: Pool,
  input: {
    sn: string;
    productKey?: string | null;
    commandType?: CommandType | null;
    policyProfileId: string;
  }
): Promise<DeviceCommandPolicyOverrideRow> => {
  const pk = input.productKey ?? null;
  const ct = input.commandType ?? null;
  const pid = input.policyProfileId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const updated = await client.query<DeviceCommandPolicyOverrideRow>(
      `UPDATE device_command_policy_overrides
       SET policy_profile_id = $4::bigint, updated_at = NOW()
       WHERE sn = $1
         AND product_key IS NOT DISTINCT FROM $2
         AND command_type IS NOT DISTINCT FROM $3
       RETURNING *`,
      [input.sn, pk, ct, pid]
    );
    if (updated.rows[0]) {
      await client.query("COMMIT");
      return updated.rows[0];
    }

    await client.query("SAVEPOINT device_policy_override_ins");

    try {
      const inserted = await client.query<DeviceCommandPolicyOverrideRow>(
        `INSERT INTO device_command_policy_overrides (
          sn, product_key, command_type, policy_profile_id
        ) VALUES ($1,$2,$3,$4::bigint)
        RETURNING *`,
        [input.sn, pk, ct, pid]
      );
      await client.query("RELEASE SAVEPOINT device_policy_override_ins");
      const row = inserted.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        throw new Error("failed_to_insert_device_policy_override");
      }
      await client.query("COMMIT");
      return row;
    } catch (err: unknown) {
      await client.query("ROLLBACK TO SAVEPOINT device_policy_override_ins");
      if (isPgDatabaseError(err) && err.code === "23505") {
        const raced = await client.query<DeviceCommandPolicyOverrideRow>(
          `UPDATE device_command_policy_overrides
           SET policy_profile_id = $4::bigint, updated_at = NOW()
           WHERE sn = $1
             AND product_key IS NOT DISTINCT FROM $2
             AND command_type IS NOT DISTINCT FROM $3
           RETURNING *`,
          [input.sn, pk, ct, pid]
        );
        if (raced.rows[0]) {
          await client.query("COMMIT");
          return raced.rows[0];
        }
      }
      await client.query("ROLLBACK");
      throw err;
    }
  } catch (err: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
};

export const getEffectivePolicyForDevice = async (
  pool: Pool,
  input: { sn: string; productKey?: string | null; commandType?: CommandType | null },
  options?: { adaptiveTiming?: boolean }
): Promise<DeviceCommandPolicyView> => {
  const adaptiveTiming = options?.adaptiveTiming ?? adaptiveTimingEnabledFromEnv();
  const withCadence = async (
    view: DeviceCommandPolicyView
  ): Promise<DeviceCommandPolicyView> => {
    if (!adaptiveTiming) {
      return view;
    }
    const cadence = await getDeviceCadence(pool, input.sn);
    const adapted = applyCadenceToPolicy(view.profile, cadence);
    return adapted === view.profile ? view : { ...view, profile: adapted };
  };
  const override = await pool.query<{
    profile: CommandPolicyProfileRow;
    override: DeviceCommandPolicyOverrideRow;
  }>(
    `SELECT row_to_json(p.*)::jsonb AS profile, row_to_json(o.*)::jsonb AS override
     FROM device_command_policy_overrides o
     JOIN command_policy_profiles p ON p.id = o.policy_profile_id
     WHERE o.sn = $1
       AND (o.product_key IS NULL OR o.product_key = $2)
       AND (o.command_type IS NULL OR o.command_type = $3)
       AND p.enabled = TRUE
     ORDER BY
       (CASE WHEN o.command_type IS NULL THEN 0 ELSE 1 END) DESC,
       (CASE WHEN o.product_key IS NULL THEN 0 ELSE 1 END) DESC,
       o.updated_at DESC
     LIMIT 1`,
    [input.sn, input.productKey ?? null, input.commandType ?? null]
  );
  const fromOverride = override.rows[0];
  if (fromOverride) {
    return withCadence({
      sn: input.sn,
      command_type: input.commandType ?? null,
      source: "override",
      override: fromOverride.override,
      profile: fromOverride.profile
    });
  }

  const defaults = await pool.query<CommandPolicyProfileRow>(
    `SELECT * FROM command_policy_profiles
     WHERE enabled = TRUE AND is_default = TRUE
     ORDER BY updated_at DESC
     LIMIT 1`
  );
  const profile = defaults.rows[0];
  if (!profile) {
    throw new Error("default_policy_profile_not_found");
  }
  return withCadence({
    sn: input.sn,
    command_type: input.commandType ?? null,
    source: "default",
    override: null,
    profile
  });
};
