import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureArtifact } from "../src/capture";
import {
  PASTE_END,
  PASTE_START,
  captureArtifactToPayload,
  createHerdrDeliveryAdapter,
  safeMessageFor,
  type DeliverExecFile,
  type SendPayload,
} from "../src/deliver";
import type { EligibleTarget } from "../src/herdr";

// Payload-agnostic send session (issue #37, PRD #24): delivery is driven by a
// SendPayload — an id, the exact string handed to `herdr agent send`, and an
// optional file that must exist first. A CaptureArtifact is just one producer
// of that shape; short clipboard text produces an inline payload with no file.

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

const TARGET_A: EligibleTarget = {
  target: "trm_01HZY8AK4M0000000000000001",
  label: "claude · idle — pane a",
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

test("captureArtifactToPayload: maps the PNG path to both the injected text and the required file, preserving the id", () => {
  const payload = captureArtifactToPayload(ARTIFACT);

  assert.deepEqual(payload, {
    id: ARTIFACT.id,
    injectText: ARTIFACT.pngPath,
    requiresFile: ARTIFACT.pngPath,
  });
});

test("deliver: an inline text payload (no requiresFile) skips the file check and injects the text itself", async () => {
  const recorder = recordingExecFile();
  let pathExistsCalls = 0;
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => {
      pathExistsCalls += 1;
      return false;
    },
  });

  const payload: SendPayload = {
    id: "clip-text-1",
    injectText: "TypeError: cannot read 'x' of undefined\n  at foo (a.ts:3)",
  };

  const outcomePromise = deliver(payload, TARGET_A);
  await flush();
  recorder.respond(null);
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { kind: "delivered" });
  assert.equal(pathExistsCalls, 0, "no file to verify — the check must be skipped");
  // The body is multi-line, so it goes on the wire bracketed (see
  // bracketMultilinePaste): unbracketed, the receiving CLI splits the stream
  // into separate pastes and can submit the leading chunk early. The payload's
  // text is carried through untouched inside the markers.
  assert.deepEqual(recorder.calls, [
    {
      file: "herdr",
      args: [
        "agent",
        "send",
        TARGET_A.target,
        `${PASTE_START}${payload.injectText}${PASTE_END}`,
      ],
    },
  ]);
});

test("deliver: a payload declaring a missing file is rejected before injecting", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => false,
  });

  const payload: SendPayload = {
    id: "spill-1",
    injectText: "/tmp/MistrFlowCaptures/spill-1.txt",
    requiresFile: "/tmp/MistrFlowCaptures/spill-1.txt",
  };

  const outcome = await deliver(payload, TARGET_A);

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-file-missing",
    message: safeMessageFor("delivery-file-missing"),
  });
  assert.deepEqual(recorder.calls, []);
});

test("deliver: a spill-file payload injects the file path once the file is verified to exist", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const payload: SendPayload = {
    id: "spill-2",
    injectText: "/tmp/MistrFlowCaptures/spill-2.txt",
    requiresFile: "/tmp/MistrFlowCaptures/spill-2.txt",
  };

  const outcomePromise = deliver(payload, TARGET_A);
  await flush();
  recorder.respond(null);
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { kind: "delivered" });
  assert.deepEqual(recorder.calls, [
    { file: "herdr", args: ["agent", "send", TARGET_A.target, payload.injectText] },
  ]);
});

test("deliver: reusing a payload id with a different injected string is rejected outright — never double-injects", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const first: SendPayload = { id: "reused-id", injectText: "the original text" };
  const firstPromise = deliver(first, TARGET_A);
  await flush();
  recorder.respond(null);
  assert.deepEqual(await firstPromise, { kind: "delivered" });

  const tampered: SendPayload = { id: "reused-id", injectText: "different text" };
  const outcome = await deliver(tampered, TARGET_A);

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-id-mismatch",
    message: safeMessageFor("delivery-id-mismatch"),
  });
  assert.equal(recorder.calls.length, 1);
});

test("deliver: retrying the exact same inline payload + target is idempotent — single injection", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const payload: SendPayload = { id: "clip-idem", injectText: "copied url" };

  const first = deliver(payload, TARGET_A);
  await flush();
  recorder.respond(null);
  assert.deepEqual(await first, { kind: "delivered" });

  const second = await deliver(payload, TARGET_A);

  assert.deepEqual(second, { kind: "delivered" });
  assert.equal(recorder.calls.length, 1);
});
