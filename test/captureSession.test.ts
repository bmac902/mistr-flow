import assert from "node:assert/strict";
import test from "node:test";

import {
  createCaptureGrabFailedError,
  runCaptureSession,
  type CaptureDeliverOutcome,
  type CapturePickerHandle,
  type CaptureSelectionEvent,
  type CaptureSessionClock,
  type RunCaptureSessionDependencies,
} from "../src/captureSession";
import type { CaptureArtifact } from "../src/capture";
import type { EligibleTarget, HerdrQueryResult } from "../src/herdr";
import type { OverlaySnapshot } from "../src/overlay";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  target: "herdr-session-a",
  label: "claude · idle — pane a",
  agentStatus: "idle",
};

const TARGET_B: EligibleTarget = {
  target: "herdr-session-b",
  label: "claude · working — pane b",
  agentStatus: "working",
};

interface FakePicker {
  handle: CapturePickerHandle;
  appendedCalls: (readonly EligibleTarget[])[];
  closeCallCount(): number;
  awaitSelectionCallCount(): number;
  resolveSelection(event: CaptureSelectionEvent): void;
}

function makeFakePicker(): FakePicker {
  const appendedCalls: (readonly EligibleTarget[])[] = [];
  let closeCalls = 0;
  let awaitCalls = 0;
  let current: ReturnType<typeof deferred<CaptureSelectionEvent>> | null = null;

  const handle: CapturePickerHandle = {
    appendTargets(targets) {
      appendedCalls.push([...targets]);
    },
    awaitSelection() {
      awaitCalls += 1;
      current = deferred<CaptureSelectionEvent>();
      return current.promise;
    },
    close() {
      closeCalls += 1;
    },
  };

  return {
    handle,
    appendedCalls,
    closeCallCount: () => closeCalls,
    awaitSelectionCallCount: () => awaitCalls,
    resolveSelection(event) {
      current!.resolve(event);
    },
  };
}

interface FakeClock {
  clock: CaptureSessionClock;
  fire(): void;
  scheduledMs: number[];
}

function makeFakeClock(): FakeClock {
  const scheduled: Array<{ cb: () => void; ms: number; handle: number }> = [];
  const cleared = new Set<number>();
  let nextHandle = 1;
  return {
    clock: {
      setTimeout(cb, ms) {
        const handle = nextHandle++;
        scheduled.push({ cb, ms, handle });
        return handle;
      },
      clearTimeout(handle) {
        cleared.add(handle as number);
      },
    },
    fire() {
      for (const s of scheduled) {
        if (!cleared.has(s.handle)) {
          s.cb();
        }
      }
    },
    get scheduledMs() {
      return scheduled.map((s) => s.ms);
    },
  };
}

function baseDeps(
  overrides: Partial<RunCaptureSessionDependencies> & {
    picker?: FakePicker;
  } = {},
): {
  deps: RunCaptureSessionDependencies;
  states: OverlaySnapshot[];
  calls: string[];
  picker: FakePicker;
} {
  const states: OverlaySnapshot[] = [];
  const calls: string[] = [];
  const picker = overrides.picker ?? makeFakePicker();

  const deps: RunCaptureSessionDependencies = {
    showOverlay(snapshot) {
      states.push(snapshot);
    },
    async captureActiveWindow() {
      calls.push("capture");
      return ARTIFACT;
    },
    openPicker() {
      calls.push("open-picker");
      return picker.handle;
    },
    async queryEligibleTargets() {
      calls.push("query-targets");
      return { kind: "targets", targets: [] };
    },
    async copyToClipboard(artifact) {
      calls.push(`clipboard:${artifact.id}`);
    },
    async deliver() {
      calls.push("deliver");
      return { kind: "delivered" };
    },
    ...overrides,
  };

  return { deps, states, calls, picker };
}

test("runCaptureSession: happy path — Clipboard usable before Herdr responds", async () => {
  const queryTargets = deferred<HerdrQueryResult>();
  const fakeClock = makeFakeClock();
  const { deps, states, calls, picker } = baseDeps({
    clock: fakeClock.clock,
    async queryEligibleTargets() {
      calls.push("query-targets");
      return queryTargets.promise;
    },
  });

  const session = runCaptureSession(deps);

  await flush();
  assert.deepEqual(calls, ["capture", "open-picker", "query-targets"]);
  assert.equal(states.length, 1);
  assert.equal(states[0].phase, "capture-picker");
  assert.equal(states[0].statusCopy, "Summoning targets…");

  picker.resolveSelection({ kind: "clipboard" });
  const result = await session;

  assert.deepEqual(result, { kind: "clipboard-delivered" });
  assert.ok(calls.includes(`clipboard:${ARTIFACT.id}`));
  assert.equal(picker.closeCallCount(), 1);
  assert.equal(states.at(-1)?.phase, "capture-delivered");
});

test("runCaptureSession: two-phase append — late Herdr response after close is ignored", async () => {
  const queryTargets = deferred<HerdrQueryResult>();
  const fakeClock = makeFakeClock();
  const { deps, states, calls, picker } = baseDeps({
    clock: fakeClock.clock,
    async queryEligibleTargets() {
      return queryTargets.promise;
    },
  });

  const session = runCaptureSession(deps);
  await flush();

  picker.resolveSelection({ kind: "clipboard" });
  await session;

  const statesBeforeLateResponse = states.length;
  const appendedBeforeLateResponse = picker.appendedCalls.length;

  queryTargets.resolve({ kind: "targets", targets: [TARGET_A] });
  await flush();

  assert.equal(picker.appendedCalls.length, appendedBeforeLateResponse);
  assert.equal(states.length, statesBeforeLateResponse);
  assert.deepEqual(calls.filter((c) => c === "clipboard:capture-uuid-1"), [
    "clipboard:capture-uuid-1",
  ]);
});

test("runCaptureSession: targets append atomically once Herdr resolves", async () => {
  const queryTargets = deferred<HerdrQueryResult>();
  const { deps, states, picker } = baseDeps({
    async queryEligibleTargets() {
      return queryTargets.promise;
    },
  });

  const session = runCaptureSession(deps);
  await flush();

  queryTargets.resolve({ kind: "targets", targets: [TARGET_A, TARGET_B] });
  await flush();

  assert.deepEqual(picker.appendedCalls, [[TARGET_A, TARGET_B]]);
  const latest = states.at(-1)!;
  assert.equal(latest.phase, "capture-picker");
  assert.deepEqual(latest.captureTargets, [TARGET_A, TARGET_B]);
  assert.equal(latest.statusCopy, "Pick your target, sir.");

  picker.resolveSelection({ kind: "target", target: TARGET_A });
  await session;
});

test("runCaptureSession: Herdr-unavailable renders explicit Clipboard-plus-Esc local-only state", async () => {
  const { deps, states, picker } = baseDeps({
    async queryEligibleTargets() {
      return {
        kind: "unavailable",
        code: "herdr-not-found",
        message: "Herdr isn't installed or running — Clipboard only, sir.",
      };
    },
  });

  const session = runCaptureSession(deps);
  await flush();

  assert.deepEqual(picker.appendedCalls, []);
  const latest = states.at(-1)!;
  assert.equal(latest.phase, "capture-picker");
  assert.deepEqual(latest.captureTargets, []);
  assert.equal(
    latest.toastCopy,
    "Herdr isn't installed or running — Clipboard only, sir.",
  );

  picker.resolveSelection({ kind: "escape" });
  await session;
});

test("runCaptureSession: version-incompatible renders its own distinct local-only state", async () => {
  const { deps, states, picker } = baseDeps({
    async queryEligibleTargets() {
      return {
        kind: "incompatible",
        code: "herdr-protocol-unsupported",
        message:
          "Herdr and Mistr Flow aren't speaking the same language — update one of them.",
      };
    },
  });

  const session = runCaptureSession(deps);
  await flush();

  assert.deepEqual(picker.appendedCalls, []);
  assert.equal(
    states.at(-1)?.toastCopy,
    "Herdr and Mistr Flow aren't speaking the same language — update one of them.",
  );

  picker.resolveSelection({ kind: "escape" });
  await session;
});

test("runCaptureSession: capture-failed renders a truthful error state and never opens the picker", async () => {
  const { deps, states, calls } = baseDeps({
    async captureActiveWindow() {
      calls.push("capture");
      throw createCaptureGrabFailedError(
        "black-image",
        "That grab came back solid black — no evidence worth keeping.",
      );
    },
  });

  const result = await runCaptureSession(deps);

  assert.deepEqual(result, {
    kind: "capture-failed",
    code: "black-image",
    message: "That grab came back solid black — no evidence worth keeping.",
  });
  assert.deepEqual(calls, ["capture"]);
  assert.equal(states.length, 1);
  assert.equal(states[0].phase, "error");
  assert.equal(
    states[0].toastCopy,
    "That grab came back solid black — no evidence worth keeping.",
  );
});

test("runCaptureSession: Esc cancels cleanly before selection and closes the picker", async () => {
  const { deps, states, picker } = baseDeps();

  const session = runCaptureSession(deps);
  await flush();

  picker.resolveSelection({ kind: "escape" });
  const result = await session;

  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(picker.closeCallCount(), 1);
  assert.equal(states.at(-1)?.phase, "cancelled");
});

test("runCaptureSession: delivered outcome closes the picker and reports the target", async () => {
  const { deps, states, calls, picker } = baseDeps({
    async deliver(_capture, target) {
      calls.push(`deliver:${target.target}`);
      return { kind: "delivered" };
    },
  });

  const session = runCaptureSession(deps);
  await flush();
  picker.resolveSelection({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(calls.filter((c) => c.startsWith("deliver:")), [
    "deliver:herdr-session-a",
  ]);
  assert.equal(picker.closeCallCount(), 1);
  assert.equal(states.some((s) => s.phase === "capture-delivering"), true);
  assert.equal(states.at(-1)?.phase, "capture-delivered");
});

test("runCaptureSession: delivery failure surfaces the safe message verbatim", async () => {
  const { deps, states, picker } = baseDeps({
    async deliver() {
      return {
        kind: "failed",
        code: "pane-gone",
        message: "That pane has left the building.",
      };
    },
  });

  const session = runCaptureSession(deps);
  await flush();
  picker.resolveSelection({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, {
    kind: "delivery-failed",
    target: TARGET_A,
    code: "pane-gone",
    message: "That pane has left the building.",
  });
  assert.equal(picker.closeCallCount(), 1);
  const latest = states.at(-1)!;
  assert.equal(latest.phase, "capture-delivery-failed");
  assert.equal(latest.toastCopy, "That pane has left the building.");
});

test("runCaptureSession: delivery-unknown never closes the picker and retries idempotently with the same artifact id", async () => {
  const deliverCalls: string[] = [];
  const firstDeliver = deferred<CaptureDeliverOutcome>();
  let call = 0;
  const { deps, states, picker } = baseDeps({
    async deliver(capture) {
      call += 1;
      deliverCalls.push(capture.id);
      if (call === 1) return firstDeliver.promise;
      return { kind: "delivered" };
    },
  });

  const session = runCaptureSession(deps);
  await flush();

  picker.resolveSelection({ kind: "target", target: TARGET_A });
  await flush();
  assert.equal(picker.closeCallCount(), 0);
  assert.equal(picker.awaitSelectionCallCount(), 1);

  firstDeliver.resolve({ kind: "unknown" });
  await flush();

  assert.equal(picker.closeCallCount(), 0);
  assert.equal(states.at(-1)?.phase, "capture-delivery-unknown");
  assert.equal(picker.awaitSelectionCallCount(), 2);

  picker.resolveSelection({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(deliverCalls, [ARTIFACT.id, ARTIFACT.id]);
  assert.equal(picker.closeCallCount(), 1);
});

test("runCaptureSession: pane-query deadline treats a hung Herdr query as the local-only state", async () => {
  const fakeClock = makeFakeClock();
  const { deps, states, picker } = baseDeps({
    clock: fakeClock.clock,
    paneQueryTimeoutMs: 2000,
    async queryEligibleTargets() {
      return new Promise(() => {
        // never resolves — exercised by the deadline firing.
      });
    },
  });

  const session = runCaptureSession(deps);
  await flush();
  assert.deepEqual(fakeClock.scheduledMs, [2000]);

  fakeClock.fire();
  await flush();

  const latest = states.at(-1)!;
  assert.equal(latest.phase, "capture-picker");
  assert.equal(
    latest.toastCopy,
    "Herdr took too long to answer — Clipboard only, sir.",
  );

  picker.resolveSelection({ kind: "escape" });
  await session;
});

test("runCaptureSession: delivery-ack deadline treats a hung deliver() as unknown", async () => {
  const fakeClock = makeFakeClock();
  const { deps, states, picker } = baseDeps({
    clock: fakeClock.clock,
    deliveryAckTimeoutMs: 3000,
    async deliver() {
      return new Promise(() => {
        // never resolves — exercised by the deadline firing.
      });
    },
  });

  const session = runCaptureSession(deps);
  await flush();
  picker.resolveSelection({ kind: "target", target: TARGET_A });
  await flush();

  assert.ok(fakeClock.scheduledMs.includes(3000));
  fakeClock.fire();
  await flush();

  assert.equal(states.at(-1)?.phase, "capture-delivery-unknown");
  assert.equal(picker.closeCallCount(), 0);

  picker.resolveSelection({ kind: "escape" });
  await session;
});
