import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureDeliverOutcome } from "../src/captureSession";
import type { EligibleTarget } from "../src/herdr";
import {
  createLastTargetMemory,
  withLastTargetRecording,
} from "../src/lastTarget";

// The Last Target memory (issue #58, ADR 0004): ONE in-process record of the
// most-recently delivered-to pane, shared across every send verb. Updated only
// by a confirmed `delivered` ack for a pane delivery — never delivery-unknown,
// never delivery-failed, and slot-1 outcomes structurally never reach it (they
// don't go through `deliver` at all). No expiry, no persistence: it dies with
// the app.

const TARGET_A: EligibleTarget = {
  target: "trm_0000000000000000000000000A",
  label: "claude · idle — pane a",
  agentStatus: "idle",
  agent: "claude",
  cwd: null,
};

const TARGET_B: EligibleTarget = {
  target: "trm_0000000000000000000000000B",
  label: "claude · working — pane b",
  agentStatus: "working",
  agent: "claude",
  cwd: null,
};

test("a fresh memory has no Last Target — fresh launch means no again-row", () => {
  const memory = createLastTargetMemory();
  assert.equal(memory.current(), null);
});

test("record replaces the previous Last Target — one memory, not a history", () => {
  const memory = createLastTargetMemory();
  memory.record(TARGET_A);
  assert.deepEqual(memory.current(), TARGET_A);

  memory.record(TARGET_B);
  assert.deepEqual(memory.current(), TARGET_B);
});

function outcomeDeliver(
  outcome: CaptureDeliverOutcome,
): (payload: { id: string }, target: EligibleTarget) => Promise<CaptureDeliverOutcome> {
  return async () => outcome;
}

test("a confirmed delivered ack records the target", async () => {
  const memory = createLastTargetMemory();
  const deliver = withLastTargetRecording(
    outcomeDeliver({ kind: "delivered" }),
    memory,
  );

  const outcome = await deliver({ id: "p-1" }, TARGET_A);

  assert.deepEqual(outcome, { kind: "delivered" });
  assert.deepEqual(memory.current(), TARGET_A);
});

test("delivery-failed never updates the memory", async () => {
  const memory = createLastTargetMemory();
  memory.record(TARGET_A);
  const deliver = withLastTargetRecording(
    outcomeDeliver({ kind: "failed", code: "delivery-pane-run-failed", message: "gone" }),
    memory,
  );

  const outcome = await deliver({ id: "p-2" }, TARGET_B);

  assert.equal(outcome.kind, "failed");
  assert.deepEqual(memory.current(), TARGET_A, "the failed target never became Last");
});

test("delivery-unknown never updates the memory — unknown is not success", async () => {
  const memory = createLastTargetMemory();
  const deliver = withLastTargetRecording(
    outcomeDeliver({ kind: "unknown" }),
    memory,
  );

  const outcome = await deliver({ id: "p-3" }, TARGET_B);

  assert.equal(outcome.kind, "unknown");
  assert.equal(memory.current(), null);
});

test("the wrapper is transparent: same outcome object, same arguments through", async () => {
  const memory = createLastTargetMemory();
  const seen: { payload: unknown; target: EligibleTarget }[] = [];
  const delivered: CaptureDeliverOutcome = { kind: "delivered" };
  const deliver = withLastTargetRecording(
    async (payload: { id: string }, target: EligibleTarget) => {
      seen.push({ payload, target });
      return delivered;
    },
    memory,
  );

  const payload = { id: "p-4" };
  const outcome = await deliver(payload, TARGET_A);

  assert.equal(outcome, delivered, "the outcome passes through untouched");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.payload, payload);
  assert.equal(seen[0]!.target, TARGET_A);
});

test("a rejected delivery propagates and records nothing", async () => {
  const memory = createLastTargetMemory();
  const deliver = withLastTargetRecording(async () => {
    throw new Error("boom");
  }, memory);

  await assert.rejects(() => deliver({ id: "p-5" }, TARGET_A), /boom/);
  assert.equal(memory.current(), null);
});
