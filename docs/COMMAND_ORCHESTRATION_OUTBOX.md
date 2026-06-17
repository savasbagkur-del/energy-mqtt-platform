# Command orchestration → durable outbox (evolution path)

## Today

- Commands are rows in `commands` with `status`, `next_attempt_at`, `policy_snapshot`, `attempt_count`.
- Worker `claimCommandsForPublish` moves eligible rows to `published` and publishes MQTT once per claim (same semantic command, no duplicate rows on ACK retry).
- Inbound telemetry remains in `raw_mqtt_messages` / `latest_state` as today.

## Tomorrow (horizontal scale / replay)

1. **Outbound outbox** — `outbound_command_deliveries` (or split columns on `commands`): `delivery_id`, `publish_attempt`, `last_error`, `idempotency_key`, `dead_letter_at`. MQTT publish becomes idempotent on `(sn, msgid)` or explicit idempotency key.
2. **Inbound queue** — optional buffer table for ordered processing per `sn` if worker pool > 1 consumer per partition.
3. **Replay** — re-drive `scheduled` → `published` from outbox state, not by inserting new commands.
4. **DLQ** — terminal `delivery_timeout` after max attempts with explicit DLQ row for ops.

Policy profiles and `device_command_policy_overrides` remain the control plane; worker only reads `policy_snapshot` on the command row.
