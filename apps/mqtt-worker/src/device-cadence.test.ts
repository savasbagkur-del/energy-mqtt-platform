import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveAdaptiveTiming, deriveGatingWindowSec, type DeviceCadenceRow } from "@communication/db";
import type { CommandPolicyProfileRow } from "@communication/db";

const baseProfile = {
  command_ttl_sec: 300,
  delivery_window_sec: 720,
  ack_timeout_sec: 4,
  retry_interval_sec: 30
} as unknown as CommandPolicyProfileRow;

const cadence = (over: Partial<DeviceCadenceRow>): DeviceCadenceRow => ({
  sn: "X",
  product_key: null,
  ewma_reconnect_sec: 90,
  last_gap_sec: 90,
  min_gap_sec: 80,
  max_gap_sec: 100,
  sample_count: 5,
  last_login_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over
});

test("deriveAdaptiveTiming: null when no cadence / too few samples / out of band", () => {
  assert.equal(deriveAdaptiveTiming(baseProfile, null), null);
  assert.equal(deriveAdaptiveTiming(baseProfile, cadence({ sample_count: 2 })), null);
  assert.equal(deriveAdaptiveTiming(baseProfile, cadence({ ewma_reconnect_sec: 2 })), null);
  assert.equal(deriveAdaptiveTiming(baseProfile, cadence({ ewma_reconnect_sec: 5000 })), null);
  assert.equal(deriveAdaptiveTiming(baseProfile, cadence({ ewma_reconnect_sec: null })), null);
});

test("deriveAdaptiveTiming: 90s cycle -> retry≈cycle, ack+retry≈cycle, window≈8 cycles", () => {
  const t = deriveAdaptiveTiming(baseProfile, cadence({ ewma_reconnect_sec: 90 }));
  assert.ok(t);
  assert.equal(t!.cycleSec, 90);
  assert.equal(t!.ackTimeoutSec, 36); // round(90*0.4)
  assert.equal(t!.retryIntervalSec, 54); // round(90*0.6)
  assert.equal(t!.ackTimeoutSec + t!.retryIntervalSec, 90);
  assert.equal(t!.deliveryWindowSec, 720); // max(90*8=720, profile 720)
  assert.equal(t!.commandTtlSec, 900); // 90*10
  assert.equal(t!.reconcileMinBackoffSec, 90);
  assert.equal(t!.reconcileMaxBackoffSec, 360);
  assert.equal(t!.gatingWindowSec, 27); // clamp(round(90*0.3=27), 10, 30)
});

test("deriveGatingWindowSec: per-device window, clamped to [10,30], null when unlearned", () => {
  assert.equal(deriveGatingWindowSec(null), null);
  assert.equal(deriveGatingWindowSec(cadence({ sample_count: 2 })), null);
  assert.equal(deriveGatingWindowSec(cadence({ ewma_reconnect_sec: null })), null);
  assert.equal(deriveGatingWindowSec(cadence({ ewma_reconnect_sec: 2 })), null); // out of sane band
  assert.equal(deriveGatingWindowSec(cadence({ ewma_reconnect_sec: 5000 })), null);
  assert.equal(deriveGatingWindowSec(cadence({ ewma_reconnect_sec: 90 })), 27);
  assert.equal(deriveGatingWindowSec(cadence({ ewma_reconnect_sec: 30 })), 10); // floor
  assert.equal(deriveGatingWindowSec(cadence({ ewma_reconnect_sec: 1000 })), 30); // cap
});

test("deriveAdaptiveTiming: delivery/ttl never shrink below configured profile", () => {
  const t = deriveAdaptiveTiming(baseProfile, cadence({ ewma_reconnect_sec: 30 }));
  assert.ok(t);
  // 30*8=240 < profile 720 -> keep 720 (lower bound = configured)
  assert.equal(t!.deliveryWindowSec, 720);
  // 30*10=300 == profile 300 -> 300
  assert.equal(t!.commandTtlSec, 300);
});

test("deriveAdaptiveTiming: long cycle widens window/ttl and clamps caps", () => {
  const t = deriveAdaptiveTiming(baseProfile, cadence({ ewma_reconnect_sec: 1000 }));
  assert.ok(t);
  assert.equal(t!.cycleSec, 1000);
  assert.equal(t!.deliveryWindowSec, 7200); // 1000*8=8000 -> capped 7200
  assert.equal(t!.commandTtlSec, 10000); // 1000*10
  assert.equal(t!.retryIntervalSec, 600); // round(1000*0.6)=600 cap
  assert.equal(t!.ackTimeoutSec, 90); // round(1000*0.4)=400 -> cap 90
  assert.equal(t!.reconcileMinBackoffSec, 900); // cap
  assert.equal(t!.reconcileMaxBackoffSec, 3600); // cap
  assert.equal(t!.gatingWindowSec, 30); // clamp(round(1000*0.3=300), 10, 30) -> cap 30
});
