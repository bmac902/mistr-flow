import assert from "node:assert/strict";
import test from "node:test";

import { CAPTURE_TTL_MS, type CaptureArtifact } from "../src/capture";
import { DELIVERY_ACK_TIMEOUT_MS } from "../src/captureSession";
import {
  createHerdrDeliveryAdapter,
  safeMessageFor,
  type DeliverExecFile,
} from "../src/deliver";
import type { EligibleTarget } from "../src/herdr";

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const ARTIFACT: CaptureArtifact = {
  id: "capture-uuid-1",
  pngPath: "/tmp/MistrFlowCaptures/capture-uuid-1.png",
  windowTitle: "Untitled — Notepad",
  processName: "notepad",
  takenAt: "2026-07-15T10:00:00.000Z",
};

const OTHER_ARTIFACT: CaptureArtifact = {
  ...ARTIFACT,
  pngPath: "/tmp/MistrFlowCaptures/some-other-file.png",
};

const TARGET_A: EligibleTarget = {
  target: "trm_01HZY8AK4M0000000000000001",
  label: "claude · idle — pane a",
  agentStatus: "idle",
};

const TARGET_B: EligibleTarget = {
  target: "trm_01HZY8AK4M0000000000000002",
  label: "claude · idle — pane b",
  agentStatus: "idle",
};

function recordingExecFile(): {
  execFile: DeliverExecFile;
  calls: { file: string; args: readonly string[] }[];
  respond: (error: (Error & { code?: string | number }) | null) => void;
} {
  const calls: { file: string; args: readonly string[] }[] = [];
  let pendingCallback:
    | ((error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void)
    | null = null;

  const execFile: DeliverExecFile = (file, args, callback) => {
    calls.push({ file, args: [...args] });
    pendingCallback = callback;
  };

  return {
    execFile,
    calls,
    respond(error) {
      const cb = pendingCallback;
      assert.ok(cb, "execFile was never invoked");
      pendingCallback = null;
      cb!(error, "", "");
    },
  };
}

test("deliver: happy path injects the exact absolute PNG path via herdr agent send", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const outcomePromise = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(null);
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { kind: "delivered" });
  assert.deepEqual(recorder.calls, [
    { file: "herdr", args: ["agent", "send", TARGET_A.target, ARTIFACT.pngPath] },
  ]);
});

test("deliver: missing PNG is rejected as a precondition — never injected into the pane", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => false,
  });

  const outcome = await deliver(ARTIFACT, TARGET_A);

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-file-missing",
    message: safeMessageFor("delivery-file-missing"),
  });
  assert.deepEqual(recorder.calls, []);
});

test("deliver: spawn failure (herdr missing) maps to herdr-not-found", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const outcomePromise = deliver(ARTIFACT, TARGET_A);
  await flush();
  const spawnError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  recorder.respond(spawnError);
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "herdr-not-found",
    message: safeMessageFor("herdr-not-found"),
  });
});

test("deliver: non-zero exit (pane rejected the run) maps to delivery-pane-run-failed", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const outcomePromise = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(new Error("exit 1"));
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-pane-run-failed",
    message: safeMessageFor("delivery-pane-run-failed"),
  });
});

test("deliver: retrying the same capture + target after settling is idempotent — single injection", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const first = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(null);
  assert.deepEqual(await first, { kind: "delivered" });

  const second = await deliver(ARTIFACT, TARGET_A);

  assert.deepEqual(second, { kind: "delivered" });
  assert.equal(recorder.calls.length, 1);
});

test("deliver: retrying while the first attempt is still in flight attaches to it — single injection", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const first = deliver(ARTIFACT, TARGET_A);
  const second = deliver(ARTIFACT, TARGET_A);
  await flush();

  assert.equal(recorder.calls.length, 1);
  recorder.respond(null);

  assert.deepEqual(await first, { kind: "delivered" });
  assert.deepEqual(await second, { kind: "delivered" });
  assert.equal(recorder.calls.length, 1);
});

test("deliver: reused capture id against a different target is rejected, never delivered wrong", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const first = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(null);
  await first;

  const outcome = await deliver(ARTIFACT, TARGET_B);

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-id-mismatch",
    message: safeMessageFor("delivery-id-mismatch"),
  });
  assert.equal(recorder.calls.length, 1);
});

test("deliver: reused capture id with a mismatched payload (pngPath) is rejected, never delivered wrong", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const first = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(null);
  await first;

  const outcome = await deliver(OTHER_ARTIFACT, TARGET_A);

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-id-mismatch",
    message: safeMessageFor("delivery-id-mismatch"),
  });
  assert.equal(recorder.calls.length, 1);
});

test("deliver: focusOnDeliver disabled (default) never calls herdr agent focus", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const outcomePromise = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(null);
  await outcomePromise;

  assert.deepEqual(recorder.calls, [
    { file: "herdr", args: ["agent", "send", TARGET_A.target, ARTIFACT.pngPath] },
  ]);
});

test("deliver: focusOnDeliver enabled focuses the target after a successful delivery", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
    focusOnDeliver: true,
  });

  const outcomePromise = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(null);
  await flush();
  recorder.respond(null);
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { kind: "delivered" });
  assert.deepEqual(recorder.calls, [
    { file: "herdr", args: ["agent", "send", TARGET_A.target, ARTIFACT.pngPath] },
    { file: "herdr", args: ["agent", "focus", TARGET_A.target] },
  ]);
});

test("deliver: focusOnDeliver enabled does not focus after a failed delivery", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
    focusOnDeliver: true,
  });

  const outcomePromise = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(new Error("exit 1"));
  const outcome = await outcomePromise;

  assert.equal(outcome.kind, "failed");
  assert.deepEqual(recorder.calls, [
    { file: "herdr", args: ["agent", "send", TARGET_A.target, ARTIFACT.pngPath] },
  ]);
});

test("deliver: a focus failure is swallowed — delivery still reports delivered", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
    focusOnDeliver: true,
  });

  const outcomePromise = deliver(ARTIFACT, TARGET_A);
  await flush();
  recorder.respond(null);
  await flush();
  recorder.respond(new Error("focus failed"));
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { kind: "delivered" });
});

test("TTL: the capture TTL comfortably outlives the delivery ack window and a retry", () => {
  // Spike finding (#28): if delivery relies on a persisted file reference,
  // the file must outlive the ack window and any retry. The ack deadline is
  // 3s; the 15-minute capture TTL gives orders of magnitude of headroom for
  // a human to notice "unknown" and press the digit again.
  assert.ok(CAPTURE_TTL_MS >= DELIVERY_ACK_TIMEOUT_MS * 10);
});
