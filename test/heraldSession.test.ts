import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHeraldArtifact,
  HERALD_HERDR_DOWN_MESSAGE,
  HERALD_NO_PANES_MESSAGE,
  HERALD_POLISHED_LABEL,
  HERALD_RAW_FALLBACK_LABEL,
  HERALD_SLOT_ONE_LABEL,
  runHeraldSession,
  type RunHeraldSessionDependencies,
} from "../src/heraldSession";
import type {
  CaptureDeliverOutcome,
  CapturePickerHandle,
  CaptureSelectionEvent,
  CaptureSessionClock,
} from "../src/captureSession";
import {
  createHerdrDeliveryAdapter,
  PASTE_END,
  PASTE_START,
  type DeliverExecFile,
  type SendPayload,
} from "../src/deliver";
import { createDictationCancelledError } from "../src/dictation";
import type { EligibleTarget, HerdrQueryResult } from "../src/herdr";
import type { OverlaySnapshot } from "../src/overlay";

// End-to-end Herald verb (issue #55, ADR 0003): dictation's front half joined
// to the send session's back half. These prove the wiring's acceptance
// criteria — record → transcribe → Polish → picker with the read-only
// transcript preview, panes on 2–9 via the shared delivery machinery, slot 1
// as the paste-here salvage, Polish always on, Esc re-dictates, and the
// picker surviving a down Herdr so the dictation is never lost.

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

const AUDIO = Buffer.alloc(1024, 1);
const RAW = "add a retry to the fetch call";
const POLISHED = "Add a retry to the fetch call.";

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- Fake picker handle (mirrors relaySession.test.ts) -----------------------

interface FakePicker {
  handle: CapturePickerHandle;
  resolve(event: CaptureSelectionEvent): void;
  appended: EligibleTarget[][];
  closeCalls(): number;
}

function makeFakePicker(): FakePicker {
  let current: ((event: CaptureSelectionEvent) => void) | null = null;
  let closeCalls = 0;
  const appended: EligibleTarget[][] = [];
  return {
    handle: {
      appendTargets(targets) {
        appended.push([...targets]);
      },
      awaitSelection() {
        return new Promise((resolve) => {
          current = resolve;
        });
      },
      close() {
        closeCalls += 1;
      },
    },
    resolve(event) {
      current!(event);
    },
    appended,
    closeCalls: () => closeCalls,
  };
}

// --- Fake clock ---------------------------------------------------------------

function makeFakeClock(): { clock: CaptureSessionClock; fire(): void } {
  const scheduled: Array<{ cb: () => void; handle: number }> = [];
  const cleared = new Set<number>();
  let next = 1;
  return {
    clock: {
      setTimeout(cb) {
        const handle = next++;
        scheduled.push({ cb, handle });
        return handle;
      },
      clearTimeout(handle) {
        cleared.add(handle as number);
      },
    },
    fire() {
      for (const s of scheduled) if (!cleared.has(s.handle)) s.cb();
    },
  };
}

interface Harness {
  deps: RunHeraldSessionDependencies;
  states: OverlaySnapshot[];
  delivered: { payload: SendPayload; target: EligibleTarget }[];
  pasted: string[];
  picker: FakePicker;
  recordCalls(): number;
  polishCalls(): string[];
  openPickerCalls(): number;
}

function makeHarness(overrides?: {
  recordAudio?: () => Promise<Buffer>;
  transcribe?: (audio: Buffer) => Promise<string>;
  polish?: (raw: string) => Promise<string>;
  queryEligibleTargets?: () => Promise<HerdrQueryResult>;
  deliver?: (
    payload: SendPayload,
    target: EligibleTarget,
  ) => Promise<CaptureDeliverOutcome>;
  clock?: CaptureSessionClock;
}): Harness {
  const states: OverlaySnapshot[] = [];
  const delivered: { payload: SendPayload; target: EligibleTarget }[] = [];
  const pasted: string[] = [];
  const picker = makeFakePicker();
  const polishCalls: string[] = [];
  let recordCalls = 0;
  let openCalls = 0;
  let minted = 0;

  const deps: RunHeraldSessionDependencies = {
    showOverlay: (snapshot) => {
      states.push(snapshot);
    },
    playBeep: () => {},
    recordAudio:
      overrides?.recordAudio ??
      (async () => {
        recordCalls += 1;
        return AUDIO;
      }),
    transcribe: overrides?.transcribe ?? (async () => RAW),
    polish:
      overrides?.polish ??
      (async (raw) => {
        polishCalls.push(raw);
        return POLISHED;
      }),
    openPicker: () => {
      openCalls += 1;
      return picker.handle;
    },
    queryEligibleTargets:
      overrides?.queryEligibleTargets ??
      (async () => ({ kind: "targets", targets: [TARGET_A, TARGET_B] })),
    deliver:
      overrides?.deliver ??
      (async (payload, target) => {
        delivered.push({ payload, target });
        return { kind: "delivered" };
      }),
    pasteHere: (text) => {
      pasted.push(text);
    },
    mintId: () => `herald-id-${++minted}`,
    clock: overrides?.clock,
  };

  // When recordAudio is overridden, recordCalls tracks via the wrapper below.
  if (overrides?.recordAudio) {
    const inner = deps.recordAudio;
    deps.recordAudio = () => {
      recordCalls += 1;
      return inner();
    };
  }

  return {
    deps,
    states,
    delivered,
    pasted,
    picker,
    recordCalls: () => recordCalls,
    polishCalls: () => polishCalls,
    openPickerCalls: () => openCalls,
  };
}

// ---------------------------------------------------------------------------
// The front half: record → transcribe → Polish, then the picker
// ---------------------------------------------------------------------------

test("firing Herald runs dictation's beats then opens the picker with the polished transcript in the read-only preview", async () => {
  const h = makeHarness();

  const session = runHeraldSession(h.deps);
  await flush();

  // Dictation's front-half beats, verbatim — no new mascot states.
  const phases = h.states.map((s) => s.phase);
  assert.deepEqual(
    phases.slice(0, 4),
    ["listening", "recording", "processing", "polishing"],
    "dictation's record/polish beats run first",
  );

  const picker = h.states.find((s) => s.phase === "capture-picker");
  assert.ok(picker, "the picker phase was rendered");
  assert.equal(picker!.clipboardSlot, true, "slot 1 is present for Herald");
  assert.equal(picker!.slotOneLabel, HERALD_SLOT_ONE_LABEL, 'slot 1 reads "Paste here"');

  // The read-only transcript preview rides the Relay text-preview slot.
  const preview = picker!.capturePreview;
  assert.ok(preview && "kind" in preview && preview.kind === "text");
  assert.equal(preview.firstLines, POLISHED, "the POLISHED text is previewed");
  assert.ok(
    preview.summary.startsWith(HERALD_POLISHED_LABEL),
    "the summary names the polished transcript",
  );

  // Panes land on the picker exactly as Capture/Relay's do (digits 2–9).
  await flush();
  assert.deepEqual(h.picker.appended, [[TARGET_A, TARGET_B]]);

  h.picker.resolve({ kind: "target", target: TARGET_A });
  await session;
});

test("Polish always runs: the delivered text is the polished transcript, never the raw one", async () => {
  const h = makeHarness();

  const session = runHeraldSession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(h.polishCalls(), [RAW], "Polish received the raw transcript");
  assert.equal(h.delivered.length, 1);
  // Inline text payload: the polished text IS the injected string, no file.
  assert.equal(h.delivered[0].payload.injectText, POLISHED);
  assert.equal(h.delivered[0].payload.requiresFile, undefined);
});

// ---------------------------------------------------------------------------
// Slot 1 — the paste-here salvage (the Ctrl+Alt+D outcome)
// ---------------------------------------------------------------------------

test("slot 1 pastes the polished text into the focused window and shows dictation's done beat", async () => {
  const h = makeHarness();

  const session = runHeraldSession(h.deps);
  await flush();
  h.picker.resolve({ kind: "clipboard" });
  const result = await session;

  assert.deepEqual(result, { kind: "pasted-here" });
  assert.deepEqual(h.pasted, [POLISHED], "the polished text was pasted here");
  assert.equal(h.delivered.length, 0, "nothing was delivered to a pane");
  assert.equal(h.states.at(-1)!.phase, "done", '"Pasted, sir." — dictation\'s existing beat');
  assert.equal(h.picker.closeCalls(), 1);
});

// ---------------------------------------------------------------------------
// Cancels and errors in the front half
// ---------------------------------------------------------------------------

test("Esc during recording cancels the whole session — no picker, nothing sent", async () => {
  const h = makeHarness({
    recordAudio: () => Promise.reject(createDictationCancelledError("escape")),
  });

  const result = await runHeraldSession(h.deps);

  assert.deepEqual(result, { kind: "cancelled", reason: "escape" });
  assert.equal(h.openPickerCalls(), 0, "no picker after a cancelled recording");
  assert.equal(h.states.at(-1)!.phase, "cancelled");
});

test("a dead-zone press cancels without any API call", async () => {
  let transcribed = 0;
  const h = makeHarness({
    recordAudio: async () => Buffer.alloc(10),
    transcribe: async () => {
      transcribed += 1;
      return RAW;
    },
  });

  const result = await runHeraldSession(h.deps);

  assert.deepEqual(result, { kind: "cancelled", reason: "dead-zone" });
  assert.equal(transcribed, 0, "nothing was sent for transcription");
  assert.equal(h.openPickerCalls(), 0);
});

test("a transcription failure is a hard error — there is nothing to route, no picker", async () => {
  const h = makeHarness({
    transcribe: async () => {
      throw new Error("whisper unavailable");
    },
  });

  const result = await runHeraldSession(h.deps);

  assert.equal(result.kind, "hard-error");
  assert.equal(h.openPickerCalls(), 0);
  assert.equal(h.states.at(-1)!.phase, "error");
  assert.equal(h.states.at(-1)!.toastCopy, "whisper unavailable");
});

test("a Polish failure routes the RAW transcript with the fallback named in the preview — spoken words are never lost", async () => {
  const h = makeHarness({
    polish: async () => {
      throw new Error("polish down");
    },
  });

  const session = runHeraldSession(h.deps);
  await flush();

  const picker = h.states.find((s) => s.phase === "capture-picker");
  assert.ok(picker, "the picker still opens — the utterance is not lost");
  const preview = picker!.capturePreview;
  assert.ok(preview && "kind" in preview && preview.kind === "text");
  assert.equal(preview.firstLines, RAW, "the raw transcript is previewed");
  assert.ok(
    preview.summary.startsWith(HERALD_RAW_FALLBACK_LABEL),
    "the summary names the fallback",
  );

  h.picker.resolve({ kind: "target", target: TARGET_A });
  const result = await session;
  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.equal(h.delivered[0].payload.injectText, RAW);
});

// ---------------------------------------------------------------------------
// Esc in the picker re-dictates (ADR 0003)
// ---------------------------------------------------------------------------

test("Esc in the picker re-dictates: a fresh recording, a fresh payload id, and the retake is what gets delivered", async () => {
  let take = 0;
  const h = makeHarness({
    transcribe: async () => `take ${++take}`,
    polish: async (raw) => `${raw}, polished.`,
  });

  const session = runHeraldSession(h.deps);
  await flush();
  assert.equal(h.recordCalls(), 1);

  // Wrong transcript → Esc → straight back into recording.
  h.picker.resolve({ kind: "escape" });
  await flush();
  assert.equal(h.recordCalls(), 2, "Esc re-dictates rather than dead-ending");
  assert.equal(h.openPickerCalls(), 2, "a fresh picker for the retake");

  h.picker.resolve({ kind: "target", target: TARGET_B });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_B });
  assert.equal(h.delivered.length, 1, "only the retake was delivered");
  assert.equal(h.delivered[0].payload.injectText, "take 2, polished.");
  assert.equal(h.delivered[0].payload.id, "herald-id-2", "each utterance mints its own payload id");
});

// ---------------------------------------------------------------------------
// Herdr down / no panes — slot 1 keeps the dictation alive
// ---------------------------------------------------------------------------

test("Herdr down: the picker still offers Paste here (slot 1), and it works — the dictation is never lost", async () => {
  const h = makeHarness({
    queryEligibleTargets: async () => ({
      kind: "unavailable",
      code: "herdr-not-found",
      message: "Herdr isn't installed or running — Clipboard only, sir.",
    }),
  });

  const session = runHeraldSession(h.deps);
  await flush();

  const state = h.states.filter((s) => s.phase === "capture-picker").at(-1);
  assert.ok(state);
  // Herald's own copy — never Herdr's "Clipboard only", which names a slot Herald lacks.
  assert.equal(state!.toastCopy, HERALD_HERDR_DOWN_MESSAGE);
  assert.equal(state!.clipboardSlot, true, "slot 1 survives a down Herdr");
  assert.equal(state!.slotOneLabel, HERALD_SLOT_ONE_LABEL);
  assert.equal(state!.pickerSummoning, false, "not stuck on the summoning beat");

  h.picker.resolve({ kind: "clipboard" });
  const result = await session;
  assert.deepEqual(result, { kind: "pasted-here" });
  assert.deepEqual(h.pasted, [POLISHED]);
});

test("a hung Herdr query (the OUTER deadline, not the query's own message) still never says Clipboard only (issue #87)", async () => {
  const fakeClock = makeFakeClock();
  const h = makeHarness({
    clock: fakeClock.clock,
    queryEligibleTargets: () =>
      new Promise(() => {
        // Never resolves — exercised by the outer deadline firing, which is
        // the path that bypassed Herald's toHeraldQueryResult remap.
      }),
  });

  const session = runHeraldSession(h.deps);
  await flush();

  fakeClock.fire();
  await flush();

  const state = h.states.filter((s) => s.phase === "capture-picker").at(-1);
  assert.ok(state);
  assert.equal(state!.toastCopy, HERALD_HERDR_DOWN_MESSAGE);
  assert.doesNotMatch(state!.toastCopy ?? "", /Clipboard only/i);
  assert.equal(state!.clipboardSlot, true, "slot 1 survives the deadline");

  h.picker.resolve({ kind: "clipboard" });
  const result = await session;
  assert.deepEqual(result, { kind: "pasted-here" });
});

test("Herdr up but no eligible panes: a truthful no-panes message, slot 1 intact", async () => {
  const h = makeHarness({
    queryEligibleTargets: async () => ({ kind: "targets", targets: [] }),
  });

  const session = runHeraldSession(h.deps);
  await flush();

  const state = h.states.filter((s) => s.phase === "capture-picker").at(-1);
  assert.equal(state!.toastCopy, HERALD_NO_PANES_MESSAGE);
  assert.equal(state!.clipboardSlot, true);
  assert.equal(state!.pickerSummoning, false);

  h.picker.resolve({ kind: "clipboard" });
  await session;
});

// ---------------------------------------------------------------------------
// Delivery machinery intact: ledger idempotency + bracketed paste
// ---------------------------------------------------------------------------

test("an ack timeout is delivery-unknown and the same digit retries via a single real injection (ledger intact)", async () => {
  const fakeClock = makeFakeClock();

  // The REAL delivery adapter (only execFile mocked) so its idempotency ledger
  // is what's under test — exactly as the Capture/Relay integration tests do.
  const execFileCalls: { args: readonly string[] }[] = [];
  let pending:
    | ((error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void)
    | null = null;
  const execFile: DeliverExecFile = (_file, args, callback) => {
    execFileCalls.push({ args: [...args] });
    pending = callback;
  };
  const realDeliver = createHerdrDeliveryAdapter({ execFile, pathExists: async () => true });

  const h = makeHarness({
    clock: fakeClock.clock,
    deliver: (payload, target) => realDeliver(payload, target),
  });

  const session = runHeraldSession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await flush();
  assert.equal(execFileCalls.length, 1, "one real herdr agent send in flight");

  // The 3s ack deadline fires before the CLI resolves → delivery-unknown.
  fakeClock.fire();
  await flush();
  assert.equal(h.states.at(-1)!.phase, "capture-delivery-unknown");

  // Same digit again — the retry attaches to the same ledger entry.
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await flush();
  assert.equal(execFileCalls.length, 1, "retry reused the in-flight delivery, never re-injected");

  pending!(null, "", "");
  const result = await session;
  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(execFileCalls[0]!.args, ["agent", "send", TARGET_A.target, POLISHED]);
});

test("a multi-line polished transcript arrives bracketed, as ONE atomic paste", async () => {
  const multiline = "First, add a retry.\nThen, log the failure.\nFinally, test it.";
  const execFileCalls: { args: readonly string[] }[] = [];
  const execFile: DeliverExecFile = (_file, args, callback) => {
    execFileCalls.push({ args: [...args] });
    callback(null, "", "");
  };
  const realDeliver = createHerdrDeliveryAdapter({ execFile, pathExists: async () => true });

  const h = makeHarness({
    polish: async () => multiline,
    deliver: (payload, target) => realDeliver(payload, target),
  });

  const session = runHeraldSession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
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
// The artifact/preview builder
// ---------------------------------------------------------------------------

test("buildHeraldArtifact previews the head of a long utterance without truncating the payload", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const artifact = buildHeraldArtifact(text, "id-1", true);

  assert.equal(artifact.payload.injectText, text, "the payload carries every line");
  assert.equal(artifact.preview.firstLines.split("\n").length, 6);
  assert.equal(artifact.preview.truncated, true);
  assert.equal(artifact.preview.lineCount, 10);
  assert.equal(artifact.preview.spilled, false);
});
