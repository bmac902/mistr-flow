import assert from "node:assert/strict";
import test from "node:test";

import { CAPTURE_TTL_MS, type CaptureArtifact } from "../src/capture";
import { DELIVERY_ACK_TIMEOUT_MS } from "../src/captureSession";
import {
  PASTE_END,
  PASTE_START,
  bracketMultilinePaste,
  captureArtifactToPayload,
  createHerdrDeliveryAdapter,
  missingFileMessage,
  safeMessageFor,
  type DeliverExecFile,
  type SendPayload,
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

// Delivery is payload-driven (#37): a CaptureArtifact is just one producer of
// a SendPayload. The tests exercise the adapter through that seam.
const PAYLOAD = captureArtifactToPayload(ARTIFACT);
const OTHER_PAYLOAD = captureArtifactToPayload(OTHER_ARTIFACT);

const TARGET_A: EligibleTarget = {
  target: "trm_01HZY8AK4M0000000000000001",
  label: "claude · idle — pane a",
  agentStatus: "idle",
  agent: "claude",
  cwd: null,
};

const TARGET_B: EligibleTarget = {
  target: "trm_01HZY8AK4M0000000000000002",
  label: "claude · idle — pane b",
  agentStatus: "idle",
  agent: "claude",
  cwd: null,
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

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
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

  const outcome = await deliver(PAYLOAD, TARGET_A);

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

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
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

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
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

  const first = deliver(PAYLOAD, TARGET_A);
  await flush();
  recorder.respond(null);
  assert.deepEqual(await first, { kind: "delivered" });

  const second = await deliver(PAYLOAD, TARGET_A);

  assert.deepEqual(second, { kind: "delivered" });
  assert.equal(recorder.calls.length, 1);
});

test("deliver: retrying while the first attempt is still in flight attaches to it — single injection", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const first = deliver(PAYLOAD, TARGET_A);
  const second = deliver(PAYLOAD, TARGET_A);
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

  const first = deliver(PAYLOAD, TARGET_A);
  await flush();
  recorder.respond(null);
  await first;

  const outcome = await deliver(PAYLOAD, TARGET_B);

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

  const first = deliver(PAYLOAD, TARGET_A);
  await flush();
  recorder.respond(null);
  await first;

  const outcome = await deliver(OTHER_PAYLOAD, TARGET_A);

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

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
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

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
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

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
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

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
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

// ---------------------------------------------------------------------------
// Bracketed paste for multi-line bodies (found live 2026-07-15)
// ---------------------------------------------------------------------------

test("bracketMultilinePaste leaves a single-line body alone — paths must stay plain", () => {
  // A single-line body is a PNG/spill path. It must arrive as plain typed
  // text so the receiving agent's own path-detection still upgrades it into a
  // real image attachment; bracketing it risks silently breaking that.
  const path = "C:\Users\blair\AppData\Local\Temp\MistrFlowCaptures\a.png";
  assert.equal(bracketMultilinePaste(path), path);
  assert.ok(!bracketMultilinePaste(path).includes(PASTE_START));
});

test("bracketMultilinePaste wraps a multi-line body so it arrives as ONE paste", () => {
  // Unbracketed, agent send streams the body in chunks and the receiving CLI
  // reads each chunk as a separate paste — observed live as
  // "[Pasted text #1 +10 lines][Pasted text #2 +9 lines]" for one 20-line
  // send. Where a chunk boundary makes a newline read as *typed* input, that
  // newline is Enter and the leading chunk submits itself, leaving only the
  // tail. Bracketing makes it atomic.
  const body = "first line\nsecond line\nthird line";
  const wrapped = bracketMultilinePaste(body);

  assert.equal(wrapped, `${PASTE_START}${body}${PASTE_END}`);
  assert.ok(wrapped.startsWith("\x1b[200~"), "opens with ESC[200~");
  assert.ok(wrapped.endsWith("\x1b[201~"), "closes with ESC[201~");
  assert.ok(wrapped.includes(body), "the body itself is untouched");
});

test("deliver: a multi-line text payload is bracketed on the wire", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const body = "Traceback (most recent call last):\n  File \"app.py\", line 42\n    raise ValueError";
  const outcomePromise = deliver(
    { id: "relay-multiline", injectText: body },
    TARGET_A,
  );
  await flush();
  recorder.respond(null);
  await outcomePromise;

  assert.deepEqual(recorder.calls, [
    {
      file: "herdr",
      args: ["agent", "send", TARGET_A.target, `${PASTE_START}${body}${PASTE_END}`],
    },
  ]);
});

// ---------------------------------------------------------------------------
// Multi-file payloads — the all-or-nothing requiresFiles guard (issue #67)
// ---------------------------------------------------------------------------

// String.raw: backslash-heavy Windows paths, exactly as CF_HDROP hands them over.
const MULTI_FILE_PATHS = [
  String.raw`C:\Users\blair\OneDrive\Documents\generate_finops_json.py`,
  String.raw`C:\Users\blair\OneDrive\Documents\finops_report.xlsx`,
  String.raw`C:\Users\blair\OneDrive\Documents\notes.md`,
];

const MULTI_FILE_PAYLOAD: SendPayload = {
  id: "relay-files-1",
  injectText: MULTI_FILE_PATHS.join("\n"),
  requiresFiles: MULTI_FILE_PATHS,
};

test("deliver: a multi-file payload verifies EVERY path before injecting, then goes on the wire bracketed", async () => {
  const recorder = recordingExecFile();
  const checked: string[] = [];
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async (filePath) => {
      checked.push(filePath);
      return true;
    },
  });

  const outcomePromise = deliver(MULTI_FILE_PAYLOAD, TARGET_A);
  await flush();
  recorder.respond(null);
  const outcome = await outcomePromise;

  assert.deepEqual(outcome, { kind: "delivered" });
  assert.deepEqual(checked, MULTI_FILE_PATHS, "all N paths verified, in order");
  // The joined body is multi-line, so bracketed-paste wraps it — that IS the
  // atomicity: one paste, never a chunk-split partial (grilled decision 1).
  assert.deepEqual(recorder.calls, [
    {
      file: "herdr",
      args: [
        "agent",
        "send",
        TARGET_A.target,
        `${PASTE_START}${MULTI_FILE_PATHS.join("\n")}${PASTE_END}`,
      ],
    },
  ]);
});

test("deliver: ANY missing file fails the WHOLE delivery, naming that file's basename — nothing injected", async () => {
  const recorder = recordingExecFile();
  const missing = MULTI_FILE_PATHS[1];
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async (filePath) => filePath !== missing,
  });

  const outcome = await deliver(MULTI_FILE_PAYLOAD, TARGET_A);

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-file-missing",
    message: missingFileMessage("finops_report.xlsx"),
  });
  assert.deepEqual(recorder.calls, [], "never a partial: nothing reached the pane");
});

test("the missing-file message names the basename and nothing else — never a raw path or error", () => {
  const message = missingFileMessage("finops_report.xlsx");
  assert.match(message, /finops_report\.xlsx/);
  assert.doesNotMatch(message, /[\\/]/, "no directories: the basename only");
  assert.match(message, /sir/i, "in the house voice");
});

test("deliver: the single-file failure message is unchanged — the basename wording is multi-file only", async () => {
  const deliver = createHerdrDeliveryAdapter({
    execFile: recordingExecFile().execFile,
    pathExists: async () => false,
  });

  const outcome = await deliver(PAYLOAD, TARGET_A);

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-file-missing",
    message: safeMessageFor("delivery-file-missing"),
  });
});

test("deliver: a spilled multi-select verifies the spill file AND every original", async () => {
  // The absurd-list case: injectText is the spill path (requiresFile), and the
  // originals stay preconditions (requiresFiles) — all-or-nothing survives the
  // spill. A vanished original fails the delivery even though the spill exists.
  const recorder = recordingExecFile();
  const spillPath = String.raw`C:\tmp\MistrFlowCaptures\relay-files-2.txt`;
  const missing = MULTI_FILE_PATHS[2];
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async (filePath) => filePath !== missing,
  });

  const outcome = await deliver(
    {
      id: "relay-files-2",
      injectText: spillPath,
      requiresFile: spillPath,
      requiresFiles: MULTI_FILE_PATHS,
    },
    TARGET_A,
  );

  assert.deepEqual(outcome, {
    kind: "failed",
    code: "delivery-file-missing",
    message: missingFileMessage("notes.md"),
  });
  assert.deepEqual(recorder.calls, []);
});

test("deliver: retrying the same multi-file payload + target is idempotent — single injection", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const first = deliver(MULTI_FILE_PAYLOAD, TARGET_A);
  await flush();
  recorder.respond(null);
  assert.deepEqual(await first, { kind: "delivered" });

  const second = await deliver(MULTI_FILE_PAYLOAD, TARGET_A);

  assert.deepEqual(second, { kind: "delivered" });
  assert.equal(recorder.calls.length, 1);
});

test("deliver: a single-line PNG path reaches the wire unbracketed", async () => {
  const recorder = recordingExecFile();
  const deliver = createHerdrDeliveryAdapter({
    execFile: recorder.execFile,
    pathExists: async () => true,
  });

  const outcomePromise = deliver(PAYLOAD, TARGET_A);
  await flush();
  recorder.respond(null);
  await outcomePromise;

  assert.deepEqual(recorder.calls, [
    { file: "herdr", args: ["agent", "send", TARGET_A.target, ARTIFACT.pngPath] },
  ]);
});
