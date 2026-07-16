import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureArtifact } from "../src/capture";
import {
  runCaptureSession,
  runSendSession,
  type CaptureDeliverOutcome,
  type CapturePickerHandle,
  type CaptureSelectionEvent,
  type CaptureSessionClock,
  type RunCaptureSessionDependencies,
} from "../src/captureSession";
import {
  captureArtifactToPayload,
  createHerdrDeliveryAdapter,
  PASTE_END,
  PASTE_START,
  type DeliverExecFile,
  type SendPayload,
} from "../src/deliver";
import type { EligibleTarget, HerdrQueryResult } from "../src/herdr";
import {
  createLastTargetMemory,
  withLastTargetRecording,
} from "../src/lastTarget";
import { runHeraldSession } from "../src/heraldSession";
import { runRelaySession } from "../src/relaySession";
import type { OverlaySnapshot } from "../src/overlay";

// Same agent again (issue #58, ADR 0004): the verb key, pressed again while
// its own picker is open, confirms to the shared Last Target. These prove the
// session-level acceptance criteria — the again-row on the picker's FIRST
// frame (from memory, before the pane query), the reconcile (present →
// refresh, gone → visibly unmark), the confirm riding the same selection
// stream the digits use (ledger, unknown → retry, bracketed paste intact),
// the truthful no-op with no row, and the truthful failure when a confirm
// races the reconcile onto a since-dead pane.

const HOTKEY = "Ctrl+Shift+`";

const ARTIFACT: CaptureArtifact = {
  id: "capture-uuid-1",
  pngPath: "/tmp/MistrFlowCaptures/capture-uuid-1.png",
  windowTitle: "Untitled — Notepad",
  processName: "notepad",
  takenAt: "2026-07-16T10:00:00.000Z",
};

const TARGET_A: EligibleTarget = {
  target: "trm_0000000000000000000000000A",
  label: "claude · idle — pane a",
  agentStatus: "idle",
};

const TARGET_B: EligibleTarget = {
  target: "trm_0000000000000000000000000B",
  label: "claude · working — pane b",
  agentStatus: "working",
};

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

interface FakePicker {
  handle: CapturePickerHandle;
  resolveSelection(event: CaptureSelectionEvent): void;
  closeCallCount(): number;
  awaitSelectionCallCount(): number;
}

function makeFakePicker(): FakePicker {
  let closeCalls = 0;
  let awaitCalls = 0;
  let current: ReturnType<typeof deferred<CaptureSelectionEvent>> | null = null;

  return {
    handle: {
      appendTargets() {},
      awaitSelection() {
        awaitCalls += 1;
        current = deferred<CaptureSelectionEvent>();
        return current.promise;
      },
      close() {
        closeCalls += 1;
      },
    },
    resolveSelection(event) {
      current!.resolve(event);
    },
    closeCallCount: () => closeCalls,
    awaitSelectionCallCount: () => awaitCalls,
  };
}

interface FakeClock {
  clock: CaptureSessionClock;
  fire(): void;
}

function makeFakeClock(): FakeClock {
  const scheduled: Array<{ cb: () => void; handle: number }> = [];
  const cleared = new Set<number>();
  let nextHandle = 1;
  return {
    clock: {
      setTimeout(cb) {
        const handle = nextHandle++;
        scheduled.push({ cb, handle });
        return handle;
      },
      clearTimeout(handle) {
        cleared.add(handle as number);
      },
    },
    fire() {
      for (const s of scheduled) {
        if (!cleared.has(s.handle)) s.cb();
      }
    },
  };
}

function baseDeps(overrides: Partial<RunCaptureSessionDependencies> = {}): {
  deps: RunCaptureSessionDependencies;
  states: OverlaySnapshot[];
  delivered: { artifact: CaptureArtifact; target: EligibleTarget }[];
  picker: FakePicker;
} {
  const states: OverlaySnapshot[] = [];
  const delivered: { artifact: CaptureArtifact; target: EligibleTarget }[] = [];
  const picker = makeFakePicker();

  const deps: RunCaptureSessionDependencies = {
    showOverlay(snapshot) {
      states.push(snapshot);
    },
    async captureActiveWindow() {
      return ARTIFACT;
    },
    openPicker() {
      return picker.handle;
    },
    async queryEligibleTargets() {
      return { kind: "targets", targets: [TARGET_A, TARGET_B] };
    },
    async deliver(artifact, target) {
      delivered.push({ artifact, target });
      return { kind: "delivered" };
    },
    ...overrides,
  };

  return { deps, states, delivered, picker };
}

function pickerFrames(states: OverlaySnapshot[]): OverlaySnapshot[] {
  return states.filter((s) => s.phase === "capture-picker");
}

// ---------------------------------------------------------------------------
// The row on the FIRST frame — rendered from memory, not the pane query
// ---------------------------------------------------------------------------

test("the again-row rides the picker's FIRST frame, from memory, before the pane query resolves", async () => {
  const query = deferred<HerdrQueryResult>();
  const { deps, states, picker } = baseDeps({
    queryEligibleTargets: () => query.promise,
  });
  deps.again = { readLastTarget: () => TARGET_A, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();

  const first = pickerFrames(states)[0];
  assert.ok(first, "the picker rendered");
  assert.equal(first!.pickerSummoning, true, "the query has NOT resolved yet");
  assert.deepEqual(
    first!.againRow,
    { label: TARGET_A.label, hotkeyLabel: HOTKEY, state: "live" },
    "the row is already there — remembered label included, no pane query needed",
  );

  query.resolve({ kind: "targets", targets: [TARGET_A, TARGET_B] });
  await flush();
  picker.resolveSelection({ kind: "escape" });
  await session;
});

test("no Last Target → no row on any frame, and the verb-key press is a truthful no-op — never the refusal", async () => {
  const { deps, states, delivered, picker } = baseDeps();
  deps.again = { readLastTarget: () => null, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();

  for (const frame of pickerFrames(states)) {
    assert.equal(frame.againRow, undefined, "no Last Target → no row");
  }

  // The verb-key press arrives anyway (main.ts can't know whether a row
  // exists) — the session absorbs it: nothing delivered, nothing refused,
  // the picker simply keeps waiting. The row's absence is the explanation.
  const awaitsBefore = picker.awaitSelectionCallCount();
  picker.resolveSelection({ kind: "again" });
  await flush();
  assert.equal(delivered.length, 0, "nothing was delivered");
  assert.equal(
    picker.awaitSelectionCallCount(),
    awaitsBefore + 1,
    "the picker is awaiting the next selection — the session did not end",
  );
  assert.ok(
    states.every((s) => s.phase !== "refused"),
    "a no-op is not the mascot refusal — nothing was refused",
  );

  // Digits are untouched: the ordinary path still delivers.
  picker.resolveSelection({ kind: "target", target: TARGET_A });
  const result = await session;
  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
});

// ---------------------------------------------------------------------------
// Reconcile when the query lands
// ---------------------------------------------------------------------------

test("reconcile, present: the row refreshes from the fresh entry and the confirm delivers to it", async () => {
  const freshA: EligibleTarget = {
    target: TARGET_A.target,
    label: "claude · working — pane a",
    agentStatus: "working",
  };
  const { deps, states, delivered, picker } = baseDeps({
    queryEligibleTargets: async () => ({ kind: "targets", targets: [freshA, TARGET_B] }),
  });
  deps.again = { readLastTarget: () => TARGET_A, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();

  const latest = pickerFrames(states).at(-1)!;
  assert.deepEqual(
    latest.againRow,
    { label: freshA.label, hotkeyLabel: HOTKEY, state: "live" },
    "the label/status refreshed from the fresh pane query",
  );

  picker.resolveSelection({ kind: "again" });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: freshA });
  assert.equal(delivered.length, 1);
  assert.deepEqual(
    delivered[0]!.target,
    freshA,
    "the confirm resolved to the FRESH entry, not the stale remembered snapshot",
  );
});

test("reconcile, absent: the row visibly unmarks — the confirm becomes a no-op, digits still work", async () => {
  const { deps, states, delivered, picker } = baseDeps({
    queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET_B] }),
  });
  deps.again = { readLastTarget: () => TARGET_A, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();

  const latest = pickerFrames(states).at(-1)!;
  assert.deepEqual(
    latest.againRow,
    { label: TARGET_A.label, hotkeyLabel: HOTKEY, state: "unmarked" },
    "gone → visibly unmarked, never silently removed",
  );

  picker.resolveSelection({ kind: "again" });
  await flush();
  assert.equal(delivered.length, 0, "an unmarked row delivers nothing");

  picker.resolveSelection({ kind: "target", target: TARGET_B });
  const result = await session;
  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_B });
});

test("reconcile, failed query: an unconfirmable fleet unmarks the row too — no live mark without a fresh sighting", async () => {
  const { deps, states, picker } = baseDeps({
    queryEligibleTargets: async () => ({
      kind: "failed",
      code: "pane-query-failed",
      message: "Couldn't reach Herdr's panes — Clipboard only, sir.",
    }),
  });
  deps.again = { readLastTarget: () => TARGET_A, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();

  assert.equal(pickerFrames(states).at(-1)!.againRow!.state, "unmarked");

  picker.resolveSelection({ kind: "escape" });
  await session;
});

// ---------------------------------------------------------------------------
// The confirm racing the reconcile — validate at use, fail truthfully
// ---------------------------------------------------------------------------

test("a confirm that races the reconcile onto a since-dead pane fails truthfully through the ordinary delivery failure", async () => {
  const query = deferred<HerdrQueryResult>();
  const { deps, states, picker } = baseDeps({
    queryEligibleTargets: () => query.promise,
    deliver: async () => ({
      kind: "failed",
      code: "delivery-pane-run-failed",
      message: "That pane has left the building — Clipboard only, sir.",
    }),
  });
  deps.again = { readLastTarget: () => TARGET_A, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();

  // The fast path: confirm BEFORE the query lands — no pre-flight blocking,
  // no pane-query latency taxed onto the send.
  picker.resolveSelection({ kind: "again" });
  const result = await session;

  assert.deepEqual(result, {
    kind: "delivery-failed",
    target: TARGET_A,
    code: "delivery-pane-run-failed",
    message: "That pane has left the building — Clipboard only, sir.",
  });
  assert.equal(states.at(-1)!.phase, "capture-delivery-failed");
});

test("a late query response never resurrects a picker the again-confirm already closed (instance binding)", async () => {
  const query = deferred<HerdrQueryResult>();
  const { deps, states, picker } = baseDeps({
    queryEligibleTargets: () => query.promise,
  });
  deps.again = { readLastTarget: () => TARGET_A, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();
  picker.resolveSelection({ kind: "again" });
  const result = await session;
  assert.equal(result.kind, "target-delivered");

  const statesAtEnd = states.length;
  query.resolve({ kind: "targets", targets: [TARGET_B] });
  await flush();
  assert.equal(states.length, statesAtEnd, "the late response mutated nothing");
});

// ---------------------------------------------------------------------------
// The same selection stream the digits use — ledger and bracketing intact
// ---------------------------------------------------------------------------

test("unknown → verb-key retry rides the delivery ledger: one real injection, then delivered", async () => {
  const fakeClock = makeFakeClock();

  // The REAL delivery adapter (only execFile mocked), exactly as the
  // Capture/Relay/Herald integration tests do — its idempotency ledger is
  // what's under test.
  const execFileCalls: { args: readonly string[] }[] = [];
  let pending:
    | ((error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void)
    | null = null;
  const execFile: DeliverExecFile = (_file, args, callback) => {
    execFileCalls.push({ args: [...args] });
    pending = callback;
  };
  const realDeliver = createHerdrDeliveryAdapter({ execFile, pathExists: async () => true });

  const { deps, states, picker } = baseDeps({
    clock: fakeClock.clock,
    deliver: (artifact, target) => realDeliver(captureArtifactToPayload(artifact), target),
  });
  deps.again = { readLastTarget: () => TARGET_A, hotkeyLabel: HOTKEY };

  const session = runCaptureSession(deps);
  await flush();

  picker.resolveSelection({ kind: "again" });
  await flush();
  assert.equal(execFileCalls.length, 1, "one real herdr agent send in flight");

  // The ack deadline fires first → delivery-unknown, picker stays open.
  fakeClock.fire();
  await flush();
  assert.equal(states.at(-1)!.phase, "capture-delivery-unknown");

  // The verb key again — the retry attaches to the same ledger entry.
  picker.resolveSelection({ kind: "again" });
  await flush();
  assert.equal(execFileCalls.length, 1, "the retry reused the in-flight delivery, never re-injected");

  pending!(null, "", "");
  const result = await session;
  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(execFileCalls[0]!.args, [
    "agent",
    "send",
    TARGET_A.target,
    ARTIFACT.pngPath,
  ]);
});

test("a multi-line payload confirmed via the verb key still arrives bracketed, as ONE atomic paste", async () => {
  const multiline = "First, add a retry.\nThen, log the failure.";
  const execFileCalls: { args: readonly string[] }[] = [];
  const execFile: DeliverExecFile = (_file, args, callback) => {
    execFileCalls.push({ args: [...args] });
    callback(null, "", "");
  };
  const realDeliver = createHerdrDeliveryAdapter({ execFile, pathExists: async () => true });

  // An inline-text artifact (Herald/Relay's shape) through the generic loop,
  // confirmed by the verb key — bracketing is payload-driven, not path-driven.
  const picker = makeFakePicker();
  const payload: SendPayload = { id: "utterance-1", injectText: multiline };
  const session = runSendSession<{ payload: SendPayload }>({
    showOverlay() {},
    captureActiveWindow: async () => ({ payload }),
    openPicker: () => picker.handle,
    queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET_A] }),
    deliver: (artifact, target) => realDeliver(artifact.payload, target),
    again: { readLastTarget: () => TARGET_A, hotkeyLabel: "Ctrl+Alt+H" },
  });
  await flush();

  picker.resolveSelection({ kind: "again" });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(execFileCalls[0]!.args, [
    "agent",
    "send",
    TARGET_A.target,
    `${PASTE_START}${multiline}${PASTE_END}`,
  ]);
});

// ---------------------------------------------------------------------------
// The full hotkey → hotkey round trip over the shared memory
// ---------------------------------------------------------------------------

test("hotkey → hotkey: a delivered pane send updates the memory, the next picker carries the row, the confirm repeats — and slot 1 never records", async () => {
  const memory = createLastTargetMemory();
  const delivered: EligibleTarget[] = [];
  const deliver = withLastTargetRecording(
    async (_artifact: CaptureArtifact, target: EligibleTarget) => {
      delivered.push(target);
      return { kind: "delivered" } as CaptureDeliverOutcome;
    },
    memory,
  );
  const again = { readLastTarget: () => memory.current(), hotkeyLabel: HOTKEY };

  // Session 1: slot 1 (Clipboard) — a local outcome, never a pane. No memory.
  {
    const { deps, picker } = baseDeps({ deliver, copyToClipboard: () => {} });
    deps.again = again;
    const session = runCaptureSession(deps);
    await flush();
    picker.resolveSelection({ kind: "clipboard" });
    assert.equal((await session).kind, "clipboard-delivered");
    assert.equal(memory.current(), null, "slot 1 never updates the Last Target");
  }

  // Session 2: an ordinary digit press delivers to pane B → B becomes Last.
  {
    const { deps, states, picker } = baseDeps({ deliver });
    deps.again = again;
    const session = runCaptureSession(deps);
    await flush();
    assert.equal(
      pickerFrames(states)[0]!.againRow,
      undefined,
      "still no row — nothing had been delivered yet",
    );
    picker.resolveSelection({ kind: "target", target: TARGET_B });
    await session;
    assert.deepEqual(memory.current(), TARGET_B);
  }

  // Session 3: the row is there from frame one; the verb key repeats to B.
  {
    const { deps, states, picker } = baseDeps({ deliver });
    deps.again = again;
    const session = runCaptureSession(deps);
    await flush();
    assert.equal(pickerFrames(states)[0]!.againRow!.label, TARGET_B.label);
    picker.resolveSelection({ kind: "again" });
    const result = await session;
    assert.deepEqual(result, { kind: "target-delivered", target: TARGET_B });
  }

  assert.deepEqual(delivered, [TARGET_B, TARGET_B]);
});

// ---------------------------------------------------------------------------
// ONE memory across the verbs — the compound flow the feature exists for
// ---------------------------------------------------------------------------

test("the Last Target is shared across verbs: Relay a stack trace, then Herald's verb key repeats to the same pane", async () => {
  const memory = createLastTargetMemory();
  const delivered: { injectText: string; target: EligibleTarget }[] = [];
  const deliver = withLastTargetRecording(
    async (payload: SendPayload, target: EligibleTarget) => {
      delivered.push({ injectText: payload.injectText, target });
      return { kind: "delivered" } as CaptureDeliverOutcome;
    },
    memory,
  );
  const again = { readLastTarget: () => memory.current(), hotkeyLabel: "Ctrl+Alt+H" };

  // Relay a stack trace to pane A (digit press) — A becomes the Last Target.
  {
    const picker = makeFakePicker();
    const session = runRelaySession({
      readClipboardSource: async () => ({
        kind: "text",
        payload: { id: "relay-1", injectText: "Traceback (most recent call last):" },
        preview: {
          kind: "text",
          firstLines: "Traceback (most recent call last):",
          truncated: false,
          lineCount: 1,
          byteSize: 34,
          spilled: false,
          summary: "Text · 1 line · 34 B",
        },
      }),
      showOverlay() {},
      openPicker: () => picker.handle,
      renderImageThumbnail: async () => null,
      cropImage: async () => null,
      queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET_A, TARGET_B] }),
      deliver,
      again,
    });
    await flush();
    picker.resolveSelection({ kind: "target", target: TARGET_A });
    assert.equal((await session).kind, "target-delivered");
    assert.deepEqual(memory.current(), TARGET_A);
  }

  // Then dictate the fix: Herald's picker carries A's row from frame one, and
  // Herald's OWN hotkey confirms to it — "again" means the same pane,
  // whichever verb carried the payload (ADR 0004, decision 1).
  {
    const picker = makeFakePicker();
    const states: OverlaySnapshot[] = [];
    const session = runHeraldSession({
      showOverlay: (s) => {
        states.push(s);
      },
      playBeep() {},
      recordAudio: async () => Buffer.alloc(1024, 1),
      transcribe: async () => "wrap it in a retry",
      polish: async () => "Wrap it in a retry.",
      openPicker: () => picker.handle,
      queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET_A, TARGET_B] }),
      deliver,
      pasteHere() {},
      mintId: () => "herald-1",
      again,
    });
    await flush();

    assert.deepEqual(
      pickerFrames(states)[0]!.againRow,
      { label: TARGET_A.label, hotkeyLabel: "Ctrl+Alt+H", state: "live" },
      "Relay's delivery marked Herald's picker — one memory, not one per verb",
    );

    picker.resolveSelection({ kind: "again" });
    const result = await session;
    assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  }

  assert.deepEqual(delivered.map((d) => d.target.target), [TARGET_A.target, TARGET_A.target]);
  assert.deepEqual(delivered.map((d) => d.injectText), [
    "Traceback (most recent call last):",
    "Wrap it in a retry.",
  ]);
});
