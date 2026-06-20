import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeBackoffMs,
  decideReconcileAction,
  planReconcileStep,
  planSwitchCycle
} from "./reconciler.js";

const PLAN_PARAMS = {
  onlineRetryIntervalSec: 7,
  offlineMinBackoffSec: 30,
  offlineMaxBackoffSec: 300,
  jitterPct: 0
};

const CYCLE_PARAMS = {
  cycleCount: 3,
  signalsPerCycle: 10,
  cycleIntervalsSec: [10, 10, 7]
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

test("planReconcileStep: reconciled -> stop (0ms)", () => {
  const p = planReconcileStep({ action: "reconciled", attemptCount: 5, ...PLAN_PARAMS });
  assert.equal(p.nextEvalMs, 0);
});

test("planReconcileStep: online actions re-drive at the fast constant cadence (7s)", () => {
  const issue = planReconcileStep({ action: "issue_command", attemptCount: 0, ...PLAN_PARAMS });
  const wait = planReconcileStep({ action: "wait_in_flight", attemptCount: 12, ...PLAN_PARAMS });
  assert.equal(issue.nextEvalMs, 7_000);
  assert.equal(wait.nextEvalMs, 7_000);
});

test("planReconcileStep: unreachable (offline) uses capped exponential backoff", () => {
  const a1 = planReconcileStep({ action: "unreachable", attemptCount: 0, ...PLAN_PARAMS }); // attempt 1 -> min
  const a3 = planReconcileStep({ action: "unreachable", attemptCount: 2, ...PLAN_PARAMS }); // attempt 3 -> 4*min
  const a9 = planReconcileStep({ action: "unreachable", attemptCount: 8, ...PLAN_PARAMS }); // clamp to max
  assert.equal(a1.nextEvalMs, 30_000);
  assert.equal(a3.nextEvalMs, 120_000);
  assert.equal(a9.nextEvalMs, 300_000);
});

test("planSwitchCycle: issues cycles 1..3 with per-cycle interval + bounded delivery window", () => {
  const c1 = planSwitchCycle({ currentCycleNo: 0, ...CYCLE_PARAMS });
  const c2 = planSwitchCycle({ currentCycleNo: 1, ...CYCLE_PARAMS });
  const c3 = planSwitchCycle({ currentCycleNo: 2, ...CYCLE_PARAMS });
  assert.equal(c1.kind, "issue");
  assert.deepEqual([c1.cycleNo, c2.cycleNo, c3.cycleNo], [1, 2, 3]);
  // intervals [10,10,7] => windows [100,100,70]
  assert.deepEqual([c1.intervalSec, c2.intervalSec, c3.intervalSec], [10, 10, 7]);
  assert.deepEqual([c1.deliveryWindowSec, c2.deliveryWindowSec, c3.deliveryWindowSec], [100, 100, 70]);
  // ack+retry ≈ interval so intra-command republish lands ~every intervalSec
  assert.equal(c1.ackTimeoutSec + c1.retryIntervalSec, 10);
  assert.equal(c3.ackTimeoutSec + c3.retryIntervalSec, 7);
});

test("planSwitchCycle: after cycleCount cycles -> exhausted (caller raises confirmation-timeout)", () => {
  const after = planSwitchCycle({ currentCycleNo: 3, ...CYCLE_PARAMS });
  assert.equal(after.kind, "exhausted");
});

test("planSwitchCycle: interval array overflow reuses the last interval", () => {
  const params = { cycleCount: 5, signalsPerCycle: 10, cycleIntervalsSec: [10, 10, 7] };
  const c4 = planSwitchCycle({ currentCycleNo: 3, ...params });
  const c5 = planSwitchCycle({ currentCycleNo: 4, ...params });
  assert.equal(c4.intervalSec, 7); // reuse last
  assert.equal(c5.intervalSec, 7);
});
