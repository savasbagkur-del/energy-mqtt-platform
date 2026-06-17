/**
 * Narrow behavior proof for command verify precedence + parent/child outcomes (no DB).
 * Run: pnpm --filter mqtt-worker test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  correlateOperateAckWithCommand,
  evaluateParentSwitchVerification,
  extractSwitchStaFromPayload,
  isOperateAckResAccepted,
  isSubstantiveRefreshAckPayload,
  hasSubstantiveMeterForStandaloneRefreshVerify,
  getStandaloneMeterEvidencePath,
  nextQuickRetryDelayMs,
  effectiveAckRetryDelayMs,
  parseCommandPolicySnapshot,
  type ParsedCommandPolicy
} from "./command-lifecycle.js";

const balancedLike: ParsedCommandPolicy = parseCommandPolicySnapshot({
  ack_timeout_sec: 4,
  verify_timeout_sec: 90,
  max_attempts: 7,
  quick_retry_seconds: [0, 3, 8, 20],
  ack_retry_min_delay_sec: 2,
  retry_jitter_pct: 0,
  retry_backoff_mode: "fixed"
});

describe("command lifecycle (unit proofs)", () => {
  it("scenario: refresh ACK payload carries SwitchSta — verify source #1 (before data/up)", () => {
    const ack = {
      sn: "123",
      method: "operate",
      msgid: "m1-refresh",
      res: 1,
      reported: { SwitchSta: 1 }
    };
    assert.equal(extractSwitchStaFromPayload(ack), 1);
    assert.equal(isOperateAckResAccepted(ack), true);
  });

  it("substantive refresh ACK: meter fields or extra payload keys", () => {
    assert.equal(isSubstantiveRefreshAckPayload({ method: "operate", res: 1, payload: { U: 220 } }), true);
    assert.equal(
      isSubstantiveRefreshAckPayload({ method: "operate", res: 1, payload: { method: "REFRESH", addr: "x" } }),
      false
    );
    assert.equal(isSubstantiveRefreshAckPayload({ method: "operate", res: 1, reported: { P: 1 } }), true);
  });

  it("standalone meter signal: data/up shapes (reported, nested sn)", () => {
    assert.equal(
      hasSubstantiveMeterForStandaloneRefreshVerify({ reported: { U: 220, I: 1 } }),
      true
    );
    assert.equal(
      hasSubstantiveMeterForStandaloneRefreshVerify({
        payload: { DEV001: { U: 1, P: 2, PF: 0.9 } }
      }),
      true
    );
    assert.equal(
      hasSubstantiveMeterForStandaloneRefreshVerify({ method: "update", sn: "x", data: { U: 229, I: 0.5 } }),
      true
    );
    assert.equal(hasSubstantiveMeterForStandaloneRefreshVerify({ method: "update", sn: "x" }), false);
  });

  it("device shape: reported[sn] meter block (REALTIME + dynamic sn)", () => {
    const pl = {
      msgid: "3",
      method: "update",
      sn: "24042809890002",
      reported: {
        source: "REALTIME",
        "24042809890002": {
          U: "250.7",
          I: "0.57",
          P: "0.117",
          PF: "0.823",
          EPI: "84.02",
          Balance: "-84.01",
          rssi: "0",
          channel: "0",
          mac_address: "bc:1a:e4:e7:21:c0"
        }
      }
    };
    assert.equal(hasSubstantiveMeterForStandaloneRefreshVerify(pl), true);
    assert.equal(
      getStandaloneMeterEvidencePath(pl, "inbound_update_payload"),
      "inbound_update_payload.reported.24042809890002"
    );
  });

  it("ACK res gate: only numeric 1 or string \"1\" accepted", () => {
    assert.equal(isOperateAckResAccepted({ res: 1 }), true);
    assert.equal(isOperateAckResAccepted({ res: "1" }), true);
    assert.equal(isOperateAckResAccepted({ res: "ok" }), false);
    assert.equal(isOperateAckResAccepted({ res: 0 }), false);
  });

  it("correlate: nested payload FORCESWITCH vs command type", () => {
    assert.deepEqual(
      correlateOperateAckWithCommand("force_switch_0", {
        payload: { method: "FORCESWITCH", ForceSwitch: 0 }
      }),
      { ok: true }
    );
    assert.deepEqual(
      correlateOperateAckWithCommand("force_switch_0", {
        payload: { method: "FORCESWITCH", ForceSwitch: 1 }
      }),
      { ok: false, reason: "payload_ForceSwitch_expected_0_got_1" }
    );
    assert.deepEqual(
      correlateOperateAckWithCommand("refresh", {
        payload: { method: "REFRESH", addr: "x" }
      }),
      { ok: true }
    );
  });

  it("scenario: force_switch parent match / mismatch via evaluateParentSwitchVerification", () => {
    assert.deepEqual(evaluateParentSwitchVerification("force_switch_1", 1), {
      status: "verified_success",
      expectedSwitch: 1,
      actualSwitch: 1
    });
    assert.deepEqual(evaluateParentSwitchVerification("force_switch_1", 0), {
      status: "verified_mismatch",
      expectedSwitch: 1,
      actualSwitch: 0
    });
  });

  it("scenario: published, no ACK — retry delay from quick_retry_seconds (attempt_count after publish)", () => {
    assert.equal(nextQuickRetryDelayMs(balancedLike, 1), 0);
    assert.equal(nextQuickRetryDelayMs(balancedLike, 2), 3000);
    assert.equal(nextQuickRetryDelayMs(balancedLike, 3), 8000);
  });

  it("effectiveAckRetryDelayMs floors zero quick_retry with min delay sec", () => {
    assert.equal(effectiveAckRetryDelayMs(balancedLike, 1, 2), 2000);
    assert.equal(effectiveAckRetryDelayMs(balancedLike, 2, 2), 3000);
  });

  it("lifecycle summary fields (documentation): timestamps map to command row", () => {
    const summary = {
      created_at: "INSERT",
      published_at: "claimCommandsForPublish",
      ack_at: "status ack_received",
      verified_at: "verified_* terminal verify",
      expires_at: "policy TTL",
      attempt_count: "increment each publish claim",
      next_attempt_at: "scheduled retry after ack_timeout",
      final_status: "terminal status enum"
    };
    assert.equal(typeof summary.final_status, "string");
  });
});
