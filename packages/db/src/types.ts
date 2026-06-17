export type ParseStatus = "parsed" | "parse_failed";
export type CommandType =
  | "refresh"
  | "force_switch_0"
  | "force_switch_1"
  | "diagnostic_refresh";
export type CommandStatus =
  | "created"
  | "scheduled"
  | "published"
  | "ack_received"
  | "verify_pending"
  | "verified_success"
  | "verified_success_with_late_confirmation"
  | "verified_mismatch"
  | "delivery_timeout"
  | "expired"
  | "cancelled"
  | "failed"
  // backward-compat statuses kept for in-flight rows
  | "publishing"
  | "publish_failed"
  | "verified_failed"
  | "verification_failed";

export interface RawMqttMessageInsert {
  direction: string;
  topic: string;
  deviceSn: string | null;
  productKey: string | null;
  protocolMsgid: string | null;
  method: string | null;
  payload: unknown;
  receivedAt: Date;
  parseStatus: ParseStatus;
  parseError: string | null;
}

export interface RawMqttMessageRow {
  id: string;
  direction: string;
  topic: string;
  device_sn: string | null;
  product_key: string | null;
  protocol_msgid: string | null;
  method: string | null;
  payload: unknown;
  received_at: string;
  parse_status: ParseStatus;
  parse_error: string | null;
  created_at: string;
}

export interface TelemetryRawRow {
  id: string;
  sn: string;
  product_key: string;
  topic: string;
  method: string;
  msgid: string | null;
  payload_json: unknown;
  parse_status: ParseStatus;
  device_sample_at: string | null;
  device_sent_at: string | null;
  worker_received_at: string;
  persisted_at: string;
  ingest_lag_ms: number | null;
  device_report_lag_sec: number | null;
  created_at: string;
}

export interface TelemetrySampleRow {
  id: string;
  sn: string;
  product_key: string;
  observed_at: string;
  source: string | null;
  voltage_v: string | null;
  current_a: string | null;
  active_power_kw: string | null;
  reactive_power_kvar: string | null;
  power_factor: string | null;
  energy_import_kwh: string | null;
  balance: string | null;
  switch_state: number | null;
  rssi: number | null;
  channel: number | null;
  mac_address: string | null;
  raw_id: string;
  created_at: string;
}

export interface DeviceLatestStateRow {
  sn: string;
  product_key: string;
  last_seen_at: string;
  last_method: string;
  last_msgid: string | null;
  last_topic: string;
  source: string | null;
  voltage_v: string | null;
  current_a: string | null;
  active_power_kw: string | null;
  reactive_power_kvar: string | null;
  power_factor: string | null;
  energy_import_kwh: string | null;
  balance: string | null;
  switch_state: number | null;
  prestate: string | null;
  owe_money: number | null;
  alarm_a: number | null;
  alarm_b: number | null;
  adf_state_1: string | null;
  adf_state_2: string | null;
  rssi: number | null;
  channel: number | null;
  mac_address: string | null;
  raw_id: string | null;
  updated_at: string;
}

export interface DeviceRow {
  sn: string;
  product_key: string | null;
  last_seen_at: string | null;
  last_method: string | null;
  devname: string | null;
  softcode: string | null;
  softversion: string | null;
  network: unknown;
  updated_at: string;
  registry_status: string;
  lifecycle_status: string;
  registered_at: string | null;
  commissioned_at: string | null;
}

/** Whether a device is operationally managed (commandable). Quarantined SNs are not. */
export const isManagedRegistryStatus = (status: string | null | undefined): boolean =>
  status === "registered" || status === "auto";

export type PropertyTypeRow = {
  id: number;
  code: string;
  label: string;
  sort_order: number;
};

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Joined registry view for the device list / detail (devices + customer + property type). */
export interface DeviceRegistryRow {
  sn: string;
  product_key: string | null;
  label: string | null;
  subscriber_no: string | null;
  customer_id: string | null;
  customer_name: string | null;
  property_type_id: number | null;
  property_type_code: string | null;
  property_type_label: string | null;
  address_line: string | null;
  district: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  tariff: string | null;
  region: string | null;
  dealer: string | null;
  install_date: string | null;
  notes: string | null;
  registry_status: string;
  lifecycle_status: string;
  registered_at: string | null;
  commissioned_at: string | null;
  last_seen_at: string | null;
}

export interface LatestStateRow {
  sn: string;
  product_key: string | null;
  last_method: string | null;
  last_msgid: string | null;
  last_timestamp: string | null;
  last_topic: string;
  last_payload: unknown;
  last_summary: unknown;
  updated_at: string;
}

/** API view for `GET /devices/:sn/summary`. */
export interface DeviceSummaryView {
  sn: string;
  product_key: string | null;
  last_method: string | null;
  last_msgid: string | null;
  last_timestamp: string | null;
  last_topic: string | null;
  summary: unknown;
}

export interface CommandRow {
  id: string;
  sn: string;
  product_key: string;
  command_type: CommandType;
  method: string;
  msgid: string;
  parent_command_id: string | null;
  status: CommandStatus;
  priority: number;
  attempt_count: number;
  next_attempt_at: string | null;
  expires_at: string | null;
  request_payload: unknown;
  ack_payload: unknown;
  verification_payload: unknown;
  policy_snapshot: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  delivery_window_anchor_at: string | null;
  ack_at: string | null;
  verified_at: string | null;
  completed_at: string | null;
}

export interface CommandEventRow {
  id: string;
  command_id: string;
  event_type: string;
  payload: unknown;
  created_at: string;
}

export interface CommandWithEvents {
  command: CommandRow;
  events: CommandEventRow[];
  children: CommandRow[];
}

export interface CommandPolicyProfileRow {
  id: string;
  code: string;
  name: string;
  is_default: boolean;
  enabled: boolean;
  ack_timeout_sec: number;
  verify_timeout_sec: number;
  command_ttl_sec: number;
  quick_retry_seconds: unknown;
  slow_retry_seconds: unknown;
  verify_refresh_delays_sec: unknown;
  refresh_budget_per_hour: number;
  diagnostics_interval_ms: number;
  diagnostics_duration_sec: number;
  max_attempts: number;
  ack_retry_min_delay_sec?: number;
  telemetry_cycle_sec?: number;
  late_confirmation_window_sec?: number;
  switch_budget_per_hour?: number;
  single_flight_enabled?: boolean;
  device_busy_mode?: string;
  retry_backoff_mode?: string;
  retry_jitter_pct?: number;
  auto_refresh_after_switch_enabled?: boolean;
  auto_refresh_delay_sec?: number;
  parent_finalize_from_child_refresh?: boolean;
  parent_late_success_enabled?: boolean;
  retry_interval_sec?: number;
  delivery_window_sec?: number;
  raise_communication_fault_enabled?: boolean;
  fault_if_online_but_no_ack_after_sec?: number | null;
  fault_if_online_but_no_verify_after_sec?: number | null;
  reconcile_enabled?: boolean;
  reconcile_min_backoff_sec?: number;
  reconcile_max_backoff_sec?: number;
  reconcile_unreachable_alarm_sec?: number;
  created_at: string;
  updated_at: string;
}

export type ReconcileStatus =
  | "pending"
  | "in_flight"
  | "reconciled"
  | "unreachable"
  | "superseded"
  | "cancelled";

export interface DeviceDesiredStateRow {
  id: string;
  sn: string;
  product_key: string | null;
  capability: string;
  desired_value: unknown;
  reported_value: unknown;
  reconcile_status: ReconcileStatus;
  desired_set_by: string | null;
  desired_set_at: string;
  last_command_id: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  next_eval_at: string;
  reconciled_at: string | null;
  unreachable_since: string | null;
  created_at: string;
  updated_at: string;
}

export type PresenceStatus = "online" | "offline";

export interface DevicePresenceRow {
  sn: string;
  status: PresenceStatus;
  connected_at: string | null;
  disconnected_at: string | null;
  last_event_at: string;
  source: string | null;
  updated_at: string;
}

export interface MqttClientBindingRow {
  clientid: string;
  product_key: string | null;
  sn: string | null;
  gateway_clientid: string | null;
  last_seen_at: string;
  created_at: string;
}

export interface DeviceCommandPolicyOverrideRow {
  id: string;
  sn: string;
  product_key: string | null;
  command_type: string | null;
  policy_profile_id: string;
  created_at: string;
  updated_at: string;
}

export interface DeviceCommandPolicyView {
  sn: string;
  command_type: string | null;
  source: "override" | "default";
  /** Present when source is override: the device_command_policy_overrides row. */
  override: DeviceCommandPolicyOverrideRow | null;
  profile: CommandPolicyProfileRow;
}

export interface DiagnosticRunRow {
  id: string;
  sn: string;
  product_key: string;
  status: string;
  interval_ms: number;
  duration_sec: number;
  planned_count: number;
  sent_count: number;
  ack_count: number;
  response_count: number;
  started_at: string | null;
  finished_at: string | null;
  summary: unknown;
  created_at: string;
}

export type AccountType = "person" | "company" | "management";
export type PropertyType = "villa" | "apartman" | "site" | "yurt";
export type UnitType =
  | "daire"
  | "oda"
  | "studyo"
  | "camasirhane"
  | "ortak_alan"
  | "ofis"
  | "depo"
  | "diger";
export type ContactRoleType =
  | "primary_account_contact"
  | "building_manager"
  | "technical_contact"
  | "owner_contact"
  | "tenant_contact"
  | "billing_contact"
  | "other";
export type OccupancyType = "owner" | "tenant" | "manager" | "vacant";
export type DomainDeviceType = "meter" | "router";
export type RecordStatus = "active" | "inactive" | "archived";

export interface DomainAccountRow {
  id: string;
  account_type: AccountType;
  legal_name: string;
  display_name: string | null;
  registration_no: string | null;
  tax_no: string | null;
  address_text: string | null;
  notes: string | null;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
}

export interface DomainContactRow {
  id: string;
  account_id: string;
  full_name: string;
  role_type: ContactRoleType;
  mobile_phone: string | null;
  landline_phone: string | null;
  email: string | null;
  is_primary: boolean;
  notes: string | null;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
}

export interface DomainPropertyRow {
  id: string;
  account_id: string;
  property_type: PropertyType;
  name: string;
  address_text: string | null;
  latitude: number | null;
  longitude: number | null;
  total_unit_count: number | null;
  manager_contact_id: string | null;
  notes: string | null;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
}

export interface DomainUnitRow {
  id: string;
  property_id: string;
  unit_type: UnitType;
  unit_code: string;
  unit_name: string | null;
  floor_no: number | null;
  description: string | null;
  notes: string | null;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
}

export interface DomainOccupancyRow {
  id: string;
  unit_id: string;
  contact_id: string;
  occupancy_type: OccupancyType;
  start_date: string;
  end_date: string | null;
  is_current: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainDeviceRow {
  id: string;
  device_type: DomainDeviceType;
  serial_no: string | null;
  manufacturer: string | null;
  model: string | null;
  firmware_version: string | null;
  mac_address: string | null;
  mqtt_sn: string | null;
  mqtt_product_key: string | null;
  notes: string | null;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
}

export interface DomainDeviceInstallationRow {
  id: string;
  device_id: string;
  property_id: string;
  unit_id: string | null;
  router_device_id: string | null;
  floor_no: number | null;
  location_note: string | null;
  signal_zone: string | null;
  initial_kwh: string | null;
  installed_at: string;
  removed_at: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
