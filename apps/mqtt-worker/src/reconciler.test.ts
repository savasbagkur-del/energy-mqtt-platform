import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBackoffMs, decideReconcileAction, planReconcileStep } from "./reconciler.js";

const PLAN_PARAMS = {
  onlineRetryIntervalSec: 7,
  onlineFailAlarmAttempts: 30,
  offlineMinBackoffSec: 30,
  offlineMaxBackoffSec: 300,
  jitterPct: 0
};

test("decideReconcileAction: reported equals desired -> reconciled (even if offline/in-flight)", () => {
  assert.equal(
    decideReconcileAction({ reported: 0, desired: 0, online: false, hasInFlight: true }),
    "reconciled"
  );
  assert.equal(
    decideReconcileAction({ reported: 1, desired: 1, online: true, hasInFlight: false }),
    "reconciled"
  );
});

test("decideReconcileAction: wrong state + offline -> unreachable (forever-until-cancel)", () => {
  assert.equal(
    decideReconcileAction({ reported: 1, desired: 0, online: false, hasInFlight: false }),
    "unreachable"
  );
  // unknown reported also counts as not-yet-confirmed
  assert.equal(
    decideReconcileAction({ reported: null, desired: 0, online: false, hasInFlight: false }),
    "unreachable"
  );
});

test("decideReconcileAction: online + in-flight -> wait (single-flight respect)", () => {
  assert.equal(
    decideReconcileAction({ reported: 1, desired: 0, online: true, hasInFlight: true }),
    "wait_in_flight"
  );
});

test("decideReconcileAction: online + idle + wrong state -> issue command", () => {
  assert.equal(
    decideReconcileAction({ reported: 1, desired: 0, online: true, hasInFlight: false }),
    "issue_command"
  );
  assert.equal(
    decideReconcileAction({ reported: null, desired: 1, online: true, hasInFlight: false }),
    "issue_command"
  );
});

test("computeBackoffMs: capped exponential within [min,max], no jitter", () => {
  // attempt 1 -> min, attempt 2 -> 2*min, attempt 3 -> 4*min, clamped to max
  assert.equal(computeBackoffMs(1, 30, 300, 0), 30_000);
  assert.equal(computeBackoffMs(2, 30, 300, 0), 60_000);
  assert.equal(computeBackoffMs(3, 30, 300, 0), 120_000);
  assert.equal(computeBackoffMs(4, 30, 300, 0), 240_000);
  assert.equal(computeBackoffMs(5, 30, 300, 0), 300_000); // 480 -> clamp 300
  assert.equal(computeBackoffMs(50, 30, 300, 0), 300_000);
});

test("computeBackoffMs: jitter keeps result within [min,max] bounds", () => {
  for (let i = 0; i < 200; i += 1) {
    const ms = computeBackoffMs(3, 30, 300, 20);
    assert.ok(ms >= 30_000, `>=min: ${ms}`);
    assert.ok(ms <= 300_000, `<=max: ${ms}`);
  }
});

test("planReconcileStep: reconciled -> stop (0ms, no alarm)", () => {
  const p = planReconcileStep({ action: "reconciled", attemptCount: 5, ...PLAN_PARAMS });
  assert.equal(p.nextEvalMs, 0);
  assert.equal(p.emitOnlineFailAlarm, false);
});

test("planReconcileStep: online actions re-drive at the fast constant cadence (7s)", () => {
  const issue = planReconcileStep({ action: "issue_command", attemptCount: 0, ...PLAN_PARAMS });
  const wait = planReconcileStep({ action: "wait_in_flight", attemptCount: 12, ...PLAN_PARAMS });
  assert.equal(issue.nextEvalMs, 7_000);
  assert.equal(wait.nextEvalMs, 7_000);
  assert.equal(wait.emitOnlineFailAlarm, false);
});

test("planReconcileStep: online-fail alarm fires exactly once on the threshold attempt", () => {
  // attemptCount is BEFORE the pass; issue makes it attemptCount+1.
  const before = planReconcileStep({ action: "issue_command", attemptCount: 28, ...PLAN_PARAMS });
  const atThreshold = planReconcileStep({ action: "issue_command", attemptCount: 29, ...PLAN_PARAMS }); // -> 30
  const after = planReconcileStep({ action: "issue_command", attemptCount: 30, ...PLAN_PARAMS }); // -> 31
  assert.equal(before.emitOnlineFailAlarm, false);
  assert.equal(atThreshold.emitOnlineFailAlarm, true);
  assert.equal(after.emitOnlineFailAlarm, false, "must not refire after the threshold");
});

test("planReconcileStep: unreachable (offline) uses capped exponential backoff, never alarms", () => {
  const a1 = planReconcileStep({ action: "unreachable", attemptCount: 0, ...PLAN_PARAMS }); // attempt 1 -> min
  const a3 = planReconcileStep({ action: "unreachable", attemptCount: 2, ...PLAN_PARAMS }); // attempt 3 -> 4*min
  const a9 = planReconcileStep({ action: "unreachable", attemptCount: 8, ...PLAN_PARAMS }); // clamp to max
  assert.equal(a1.nextEvalMs, 30_000);
  assert.equal(a3.nextEvalMs, 120_000);
  assert.equal(a9.nextEvalMs, 300_000);
  assert.equal(a1.emitOnlineFailAlarm, false);
  assert.equal(a9.emitOnlineFailAlarm, false);
});
