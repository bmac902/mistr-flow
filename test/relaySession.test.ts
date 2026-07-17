import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  runRelaySession,
  RELAY_HERDR_DOWN_MESSAGE,
  RELAY_NO_PANES_MESSAGE,
  type RunRelaySessionDependencies,
} from "../src/relaySession";
import { createLastTargetMemory, withLastTargetRecording } from "../src/lastTarget";
import { RELAY_COPY_KEPT_STATUS_COPY } from "../src/overlay";
import type {
  CaptureSessionClock,
  CapturePickerHandle,
  CaptureSelectionEvent,
} from "../src/captureSession";
import {
  CLIPBOARD_SPILL_THRESHOLD,
  readClipboardSource,
  type ClipboardImagePort,
  type ClipboardSource,
  type ClipboardSourcePort,
} from "../src/clipboardSource";
import {
  PASTE_END,
  PASTE_START,
  createHerdrDeliveryAdapter,
  missingFileMessage,
  type DeliverExecFile,
  type SendPayload,
} from "../src/deliver";
import type { EligibleTarget, HerdrQueryResult } from "../src/herdr";
import type { OverlaySnapshot } from "../src/overlay";
import type { CaptureDeliverOutcome } from "../src/captureSession";
import type { PickerPreview } from "../src/captureThumbnail";

/** The image preview carries no `kind`; the text preview's is "text". */
function isTextPreview(preview: PickerPreview | undefined): boolean {
  return !!preview && "kind" in preview && preview.kind === "text";
}

// End-to-end Relay verb (issue #39, PRD #24; slot 1 returned in #64): the
// clipboard source (#38) driven through the shared send session (#37). These
// prove the wiring's acceptance criteria — the empty state, the picker with
// slot 1 ("1 Clipboard" = keep the copy, stop here) and panes on 2–9, delivery
// via the payload-agnostic adapter, and the truthful Herdr-down state.

const CAPTURE_DIR = "/tmp/MistrFlowCaptures";

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

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- Fake clipboard port (mirrors clipboardSource.test.ts) ------------------

function fakeClipboardPort(options: {
  text?: string;
  imagePng?: Buffer | null;
  filePath?: string | null;
  /** The FileDropList shell-out's result (mirrors clipboardSource.test.ts). */
  dropList?: string[] | null;
  /** When supplied, records every writeFile path — the slot-1 no-write guard. */
  writes?: string[];
}): ClipboardSourcePort {
  const imagePng = options.imagePng;
  const image: ClipboardImagePort = {
    isEmpty: () => imagePng == null || imagePng.length === 0,
    toPNG: () => imagePng ?? Buffer.alloc(0),
  };
  let minted = 0;
  return {
    readText: () => options.text ?? "",
    readImage: () => image,
    // FileNameW always accompanies a real file drop (mirrors the invariant
    // documented in clipboardSource.test.ts) — readFilePath gates the
    // drop-list shell-out (#72), so a fake drop list needs it non-null.
    readFilePath: () => options.filePath ?? options.dropList?.[0] ?? null,
    readFileDropList: async () => options.dropList ?? null,
    writeFile: async (filePath) => {
      options.writes?.push(filePath);
    },
    mintId: () => `relay-id-${++minted}`,
    timestampIso: () => "2026-07-16T09:00:00.000Z",
    captureDir: CAPTURE_DIR,
  };
}

const MULTI_SELECT = [
  String.raw`C:\Users\blair\OneDrive\Documents\generate_finops_json.py`,
  String.raw`C:\Users\blair\OneDrive\Documents\finops_report.xlsx`,
  String.raw`C:\Users\blair\OneDrive\Documents\notes.md`,
];

// --- Fake picker handle -----------------------------------------------------

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

// --- Fake clock -------------------------------------------------------------

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

// A never-resolving query so the picker sits in its populated/summoning state
// without a late response mutating it under the test.
function neverResolves(): Promise<HerdrQueryResult> {
  return new Promise(() => {});
}

interface Harness {
  deps: RunRelaySessionDependencies;
  states: OverlaySnapshot[];
  delivered: { payload: SendPayload; target: EligibleTarget }[];
  picker: FakePicker;
  openPickerCalls(): number;
}

function makeHarness(overrides: {
  port: ClipboardSourcePort;
  queryEligibleTargets?: () => Promise<HerdrQueryResult>;
  deliver?: (
    payload: SendPayload,
    target: EligibleTarget,
  ) => Promise<CaptureDeliverOutcome>;
  clock?: CaptureSessionClock;
}): Harness {
  const states: OverlaySnapshot[] = [];
  const delivered: { payload: SendPayload; target: EligibleTarget }[] = [];
  const picker = makeFakePicker();
  let openCalls = 0;

  const deps: RunRelaySessionDependencies = {
    readClipboardSource: () => readClipboardSource(overrides.port),
    showOverlay: (snapshot) => {
      states.push(snapshot);
    },
    openPicker: () => {
      openCalls += 1;
      return picker.handle;
    },
    renderImageThumbnail: async (artifact) => ({
      dataUrl: `data:image/png;base64,${artifact.id}`,
      windowTitle: artifact.windowTitle,
    }),
    cropImage: async () => null,
    queryEligibleTargets:
      overrides.queryEligibleTargets ??
      (async () => ({ kind: "targets", targets: [TARGET_A, TARGET_B] })),
    deliver:
      overrides.deliver ??
      (async (payload, target) => {
        delivered.push({ payload, target });
        return { kind: "delivered" };
      }),
    clock: overrides.clock,
  };

  return { deps, states, delivered, picker, openPickerCalls: () => openCalls };
}

// ---------------------------------------------------------------------------
// Empty clipboard — nothing to send, no picker
// ---------------------------------------------------------------------------

test("an empty clipboard renders the nothing-to-send state and never opens a picker", async () => {
  const h = makeHarness({ port: fakeClipboardPort({ text: "", imagePng: null }) });

  const result = await runRelaySession(h.deps);

  assert.deepEqual(result, { kind: "nothing-to-send" });
  assert.equal(h.openPickerCalls(), 0, "no target picker for an empty clipboard");
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].phase, "relay-nothing-to-send");
  assert.equal(h.states[0].captureTargets, undefined);
});

// ---------------------------------------------------------------------------
// Text — picker shape + delivery
// ---------------------------------------------------------------------------

test("copying text opens a picker with slot 1 (Clipboard, the renderer default label) and panes on 2–9", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "const x = 1;\nconst y = 2;" }),
  });

  const session = runRelaySession(h.deps);
  await flush();

  const picker = h.states.find((s) => s.phase === "capture-picker");
  assert.ok(picker, "the picker phase was rendered");
  // Slot 1 returned (#64): "1 Clipboard" = keep the copy, stop here.
  assert.equal(picker!.clipboardSlot, true, "slot 1 renders for Relay");
  // No slotOneLabel override — the renderer's "Clipboard" default, byte-identical
  // to Capture's (CONTEXT.md: Capture and Relay both label it "Clipboard").
  assert.equal(picker!.slotOneLabel, undefined);
  assert.ok(isTextPreview(picker!.capturePreview), "a text preview, not a thumbnail");

  // Panes land on the picker exactly as Capture's do (digits 2–9 via the handle).
  const populated = h.states.filter(
    (s) => s.phase === "capture-picker" && (s.captureTargets?.length ?? 0) > 0,
  );
  assert.deepEqual(populated.at(-1)!.captureTargets, [TARGET_A, TARGET_B]);
  assert.deepEqual(h.picker.appended, [[TARGET_A, TARGET_B]]);

  // Dismiss to settle the session.
  h.picker.resolve({ kind: "escape" });
  await session;
});

test("short copied text delivers inline via the payload-agnostic adapter (no spill)", async () => {
  const text = "TypeError: cannot read property 'x' of undefined";
  const h = makeHarness({ port: fakeClipboardPort({ text }) });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].target.target, TARGET_A.target);
  // Inline: the injected text IS the copied content, with no required file.
  assert.equal(h.delivered[0].payload.injectText, text);
  assert.equal(h.delivered[0].payload.requiresFile, undefined);
});

test("long copied text delivers the spill file's path, not the text", async () => {
  const bigText = "x".repeat(CLIPBOARD_SPILL_THRESHOLD + 1);
  const h = makeHarness({ port: fakeClipboardPort({ text: bigText }) });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_B });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_B });
  const payload = h.delivered[0].payload;
  assert.match(payload.injectText, /relay-id-1\.txt$/, "injects the spill path");
  assert.equal(payload.requiresFile, payload.injectText, "the spill file is a delivery precondition");
});

test("a clipboard image delivers the PNG's path", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "", imagePng: Buffer.from([1, 2, 3, 4]) }),
  });

  const session = runRelaySession(h.deps);
  await flush();

  // The preview is a thumbnail for an image, not text.
  const picker = h.states.find((s) => s.phase === "capture-picker");
  assert.ok(!isTextPreview(picker!.capturePreview), "an image thumbnail, not a text head");

  h.picker.resolve({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  const payload = h.delivered[0].payload;
  assert.match(payload.injectText, /relay-id-1\.png$/, "injects the PNG path");
  assert.equal(payload.requiresFile, payload.injectText);
});

// ---------------------------------------------------------------------------
// Herdr unavailable — the copy is safe on the clipboard, slot 1 stays usable
// ---------------------------------------------------------------------------

test("Herdr unavailable degrades to Clipboard + Esc — the truthful copy-is-safe message, never 'nowhere to send it'", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "copied url" }),
    queryEligibleTargets: async () => ({
      kind: "unavailable",
      code: "herdr-not-found",
      message: "Herdr isn't installed or running — Clipboard only, sir.",
    }),
  });

  const session = runRelaySession(h.deps);
  await flush();

  const downState = h.states
    .filter((s) => s.phase === "capture-picker")
    .at(-1);
  assert.ok(downState);
  // Relay's own copy — with slot 1 returned (#64) "nowhere to send it" is
  // false, so the message says the copy is safe on the clipboard instead.
  assert.equal(downState!.toastCopy, RELAY_HERDR_DOWN_MESSAGE);
  assert.match(RELAY_HERDR_DOWN_MESSAGE, /clipboard/i, "the message names where the copy is");
  assert.doesNotMatch(RELAY_HERDR_DOWN_MESSAGE, /nowhere/i);
  assert.deepEqual(downState!.captureTargets, [], "no target list");
  assert.equal(downState!.clipboardSlot, true, "slot 1 survives a down Herdr");
  assert.equal(downState!.pickerSummoning, false, "not stuck on the summoning beat");

  // No auto-fade — and slot 1 stays usable: keeping the copy still works.
  h.picker.resolve({ kind: "clipboard" });
  const result = await session;
  assert.deepEqual(result, { kind: "copy-kept" });
  assert.equal(h.picker.closeCalls(), 1, "picker closed cleanly");
});

test("Herdr up but with no eligible panes is a truthful no-panes state — copy on the clipboard, slot 1 intact", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "copied url" }),
    queryEligibleTargets: async () => ({ kind: "targets", targets: [] }),
  });

  const session = runRelaySession(h.deps);
  await flush();

  const state = h.states.filter((s) => s.phase === "capture-picker").at(-1);
  assert.equal(state!.toastCopy, RELAY_NO_PANES_MESSAGE);
  assert.match(RELAY_NO_PANES_MESSAGE, /clipboard/i);
  assert.doesNotMatch(RELAY_NO_PANES_MESSAGE, /nowhere/i);
  assert.equal(state!.clipboardSlot, true, "slot 1 intact with an empty fleet");
  assert.equal(state!.pickerSummoning, false);

  h.picker.resolve({ kind: "escape" });
  await session;
});

// ---------------------------------------------------------------------------
// Slot 1 — keep the copy, stop here (issue #64)
// ---------------------------------------------------------------------------

test("slot 1 ends with copy-kept and the success beat — never the cancelled beat", async () => {
  const h = makeHarness({ port: fakeClipboardPort({ text: "copied url" }) });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "clipboard" });
  const result = await session;

  // The kept-copy ending is distinct in logs — never a bare clipboard-delivered
  // (Herald's pasted-here mapping, mirrored).
  assert.deepEqual(result, { kind: "copy-kept" });
  assert.equal(h.picker.closeCalls(), 1, "picker closed on the local ending");

  // An affirmative local ending: an existing success phase with Relay-specific
  // status copy naming the outcome — and never Esc's cancelled beat.
  const beat = h.states.at(-1)!;
  assert.equal(beat.phase, "done", "reuses an existing mascot phase — no new art");
  assert.equal(beat.statusCopy, RELAY_COPY_KEPT_STATUS_COPY);
  assert.ok(!h.states.some((s) => s.phase === "cancelled"), "never the cancelled beat");
});

test("slot 1 renders and works for every source kind — text, file, and image", async () => {
  // A relayed IMAGE especially: keeping the copy must not re-write (and so
  // re-encode) the clipboard — slot 1 delivers nothing and writes nothing.
  const ports = {
    text: fakeClipboardPort({ text: "copied url" }),
    file: fakeClipboardPort({ filePath: "C:\\dev\\thing.py" }),
    image: fakeClipboardPort({ text: "", imagePng: Buffer.from([1, 2, 3, 4]) }),
  };

  for (const [kind, port] of Object.entries(ports)) {
    const h = makeHarness({ port });
    const session = runRelaySession(h.deps);
    await flush();

    const picker = h.states.find((s) => s.phase === "capture-picker");
    assert.equal(picker!.clipboardSlot, true, `slot 1 renders for a ${kind} source`);

    h.picker.resolve({ kind: "clipboard" });
    const result = await session;
    assert.deepEqual(result, { kind: "copy-kept" }, `${kind}: the copy is kept`);
    assert.equal(h.delivered.length, 0, `${kind}: slot 1 bypasses deliver entirely`);
  }
});

test("Esc still cancels with the cancelled beat — the affirmative ending didn't eat the escape hatch", async () => {
  const h = makeHarness({ port: fakeClipboardPort({ text: "copied url" }) });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "escape" });
  const result = await session;

  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(h.states.at(-1)!.phase, "cancelled");
});

test("slot 1 never updates the Last Target — a pane delivery does", async () => {
  const memory = createLastTargetMemory();

  // Session 1: slot 1 (keep the copy) — bypasses deliver, so structurally
  // nothing can record (src/lastTarget.ts wraps deliver, and slot 1 never
  // calls it).
  const kept = makeHarness({ port: fakeClipboardPort({ text: "copied url" }) });
  kept.deps.deliver = withLastTargetRecording(kept.deps.deliver, memory);
  const keptSession = runRelaySession(kept.deps);
  await flush();
  kept.picker.resolve({ kind: "clipboard" });
  await keptSession;
  assert.equal(memory.current(), null, "slot 1 never updates the Last Target");

  // Session 2: a digit delivery records — proving the wrapper was live and
  // slot 1's null above wasn't a wiring accident.
  const sent = makeHarness({ port: fakeClipboardPort({ text: "copied url" }) });
  sent.deps.deliver = withLastTargetRecording(sent.deps.deliver, memory);
  const sentSession = runRelaySession(sent.deps);
  await flush();
  sent.picker.resolve({ kind: "target", target: TARGET_A });
  await sentSession;
  assert.deepEqual(memory.current(), TARGET_A);
});

test("slot 1 writes nothing: the session has no clipboard-write seam and never sees copySelectionFirst", () => {
  // Structural guards (house pattern: clickablePickerRows.test.ts reads main.ts):
  // the content is ALREADY on the clipboard — whether the user copied it or
  // main.ts's copySelectionFirst did, before the session opened — so the
  // session must never re-write it (a relayed image would be clobbered by a
  // re-encode), and must behave identically with the flag on or off.
  const source = readFileSync(
    path.join(__dirname, "..", "src", "relaySession.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /copyToClipboard/, "the copyToClipboard dep is omitted");
  assert.doesNotMatch(source, /copySelectionFirst/, "the flag lives in main.ts, before the session");
});

test("main.ts wiring: openRelayPicker builds the picker WITH slot 1 (#64)", () => {
  const main = readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
  const fromFactory = main.slice(main.indexOf("function openRelayPicker"));
  const factory = fromFactory.slice(0, fromFactory.indexOf("\n}"));
  assert.match(factory, /includeClipboardSlot: true/, "digit 1 registers for Relay");
});

// ---------------------------------------------------------------------------
// Delivery outcomes — reuse Capture's exactly
// ---------------------------------------------------------------------------

test("a failed delivery surfaces the safe message and the delivery-failed result", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "copied url" }),
    deliver: async () => ({
      kind: "failed",
      code: "delivery-pane-run-failed",
      message: "That pane has left the building — Clipboard only, sir.",
    }),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, {
    kind: "delivery-failed",
    target: TARGET_A,
    code: "delivery-pane-run-failed",
    message: "That pane has left the building — Clipboard only, sir.",
  });
  assert.equal(h.states.at(-1)!.phase, "capture-delivery-failed");
});

test("an ack timeout is delivery-unknown and the same digit retries via a single real injection", async () => {
  const fakeClock = makeFakeClock();

  // The REAL delivery adapter (only execFile mocked) so its idempotency ledger
  // is what's under test — exactly as the Capture verb's integration test does.
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
    port: fakeClipboardPort({ text: "copied url" }),
    clock: fakeClock.clock,
    deliver: (payload, target) => realDeliver(payload, target),
  });

  const session = runRelaySession(h.deps);
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
  assert.deepEqual(execFileCalls[0]!.args, ["agent", "send", TARGET_A.target, "copied url"]);
});

// ---------------------------------------------------------------------------
// Slot alignment sanity: a text relay's payload id matches the source
// ---------------------------------------------------------------------------

test("the delivered payload is exactly the clipboard source's payload (no re-mint)", async () => {
  const port = fakeClipboardPort({ text: "copied url" });
  // Read the source directly to know the payload it produced.
  const source = (await readClipboardSource(port)) as Extract<
    ClipboardSource,
    { kind: "text" }
  >;

  // A fresh port for the session (mintId is stateful), producing an identical payload.
  const h = makeHarness({ port: fakeClipboardPort({ text: "copied url" }) });
  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await session;

  assert.equal(h.delivered[0].payload.injectText, source.payload.injectText);
});

// ---------------------------------------------------------------------------
// Payload-aware delivering beats (issue #41)
// ---------------------------------------------------------------------------

test("short text delivers with the NOTE prop; delivered tips the hat", async () => {
  const h = makeHarness({ port: fakeClipboardPort({ text: "a short line" }) });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await session;

  const delivering = h.states.find((s) => s.phase === "relay-delivering");
  assert.ok(delivering, "a relay-delivering beat was emitted");
  assert.equal(delivering!.relayPayloadKind, "note");
  assert.equal(delivering!.ledgerSpill, false);

  assert.ok(h.states.some((s) => s.phase === "relay-delivered"));
});

test("spilled text delivers with the LEDGER prop (the spill modifier)", async () => {
  const bigText = "y".repeat(CLIPBOARD_SPILL_THRESHOLD + 1);
  const h = makeHarness({ port: fakeClipboardPort({ text: bigText }) });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await session;

  const delivering = h.states.find((s) => s.phase === "relay-delivering");
  assert.equal(delivering!.relayPayloadKind, "ledger");
  assert.equal(delivering!.ledgerSpill, true, "the ledger is the spill modifier");
});

test("an image delivers with the PORTRAIT prop", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "", imagePng: Buffer.from([1, 2, 3, 4]) }),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await session;

  const delivering = h.states.find((s) => s.phase === "relay-delivering");
  assert.equal(delivering!.relayPayloadKind, "portrait");
});

test("a copied file delivers with the LEDGER prop — it injects a path like a spill", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ filePath: "C:\dev\thing.py" }),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await session;

  const delivering = h.states.find((s) => s.phase === "relay-delivering");
  assert.equal(delivering!.relayPayloadKind, "ledger");
});

// ---------------------------------------------------------------------------
// Multi-file relay — every file of a multi-select, one atomic block (issue #67)
// ---------------------------------------------------------------------------

test("a multi-select delivers as ONE bracketed paste of all N full paths", async () => {
  // The REAL adapter with only execFile mocked (the ack-timeout precedent):
  // the joined body is multi-line, so bracketMultilinePaste wraps it — that
  // IS the atomicity, one paste that can never chunk-split into a partial.
  const execFileCalls: { args: readonly string[] }[] = [];
  const execFile: DeliverExecFile = (_file, args, callback) => {
    execFileCalls.push({ args: [...args] });
    callback(null, "", "");
  };
  const realDeliver = createHerdrDeliveryAdapter({ execFile, pathExists: async () => true });

  const h = makeHarness({
    port: fakeClipboardPort({ dropList: MULTI_SELECT }),
    deliver: (payload, target) => realDeliver(payload, target),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(execFileCalls, [
    {
      args: [
        "agent",
        "send",
        TARGET_A.target,
        `${PASTE_START}${MULTI_SELECT.join("\n")}${PASTE_END}`,
      ],
    },
  ]);
});

test("the multi-select preview rides the existing text-preview slot: full paths, Files · N", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ dropList: MULTI_SELECT }),
  });

  const session = runRelaySession(h.deps);
  await flush();

  const picker = h.states.find((s) => s.phase === "capture-picker");
  assert.ok(isTextPreview(picker!.capturePreview), "no new preview kind — the text slot");
  const preview = picker!.capturePreview as Extract<PickerPreview, { kind: "text" }>;
  assert.equal(preview.firstLines, MULTI_SELECT.join("\n"), "full paths, one per line");
  assert.equal(preview.summary, `Files · ${MULTI_SELECT.length}`);

  h.picker.resolve({ kind: "escape" });
  await session;
});

test("a multi-select delivers with the LEDGER prop — a path-injecting payload per #41's mapping", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ dropList: MULTI_SELECT }),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await session;

  const delivering = h.states.find((s) => s.phase === "relay-delivering");
  assert.equal(delivering!.relayPayloadKind, "ledger");
});

test("a vanished file fails the WHOLE multi-select truthfully, naming the file — nothing injected", async () => {
  const execFileCalls: unknown[] = [];
  const execFile: DeliverExecFile = (_file, args, callback) => {
    execFileCalls.push(args);
    callback(null, "", "");
  };
  const realDeliver = createHerdrDeliveryAdapter({
    execFile,
    // The .xlsx vanished between the copy and the digit press.
    pathExists: async (filePath) => !filePath.endsWith(".xlsx"),
  });

  const h = makeHarness({
    port: fakeClipboardPort({ dropList: MULTI_SELECT }),
    deliver: (payload, target) => realDeliver(payload, target),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  const result = await session;

  assert.deepEqual(result, {
    kind: "delivery-failed",
    target: TARGET_A,
    code: "delivery-file-missing",
    message: missingFileMessage("finops_report.xlsx"),
  });
  assert.deepEqual(execFileCalls, [], "all-or-nothing: nothing reached the pane");
  assert.equal(h.states.at(-1)!.phase, "capture-delivery-failed");
});

test("slot 1 keeps a multi-select fully intact — nothing delivered, nothing written, CF_HDROP untouched", async () => {
  const writes: string[] = [];
  const h = makeHarness({
    port: fakeClipboardPort({ dropList: MULTI_SELECT, writes }),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "clipboard" });
  const result = await session;

  assert.deepEqual(result, { kind: "copy-kept" });
  assert.equal(h.delivered.length, 0, "slot 1 bypasses deliver entirely");
  // No port write of any kind: the session has no clipboard-write seam at all
  // (asserted structurally below), and the source never spilled — so the
  // multi-select's CF_HDROP sits on the clipboard exactly as Explorer put it.
  assert.deepEqual(writes, [], "no write through the port");
});

test("a multi-select retry after delivery-unknown reuses the same payload — one real injection", async () => {
  const fakeClock = makeFakeClock();
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
    port: fakeClipboardPort({ dropList: MULTI_SELECT }),
    clock: fakeClock.clock,
    deliver: (payload, target) => realDeliver(payload, target),
  });

  const session = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await flush();
  assert.equal(execFileCalls.length, 1, "one real herdr agent send in flight");

  // The 3s ack deadline fires first → delivery-unknown; the same digit retries.
  fakeClock.fire();
  await flush();
  assert.equal(h.states.at(-1)!.phase, "capture-delivery-unknown");
  h.picker.resolve({ kind: "target", target: TARGET_A });
  await flush();
  assert.equal(execFileCalls.length, 1, "the retry attached to the ledger, never re-injected");

  pending!(null, "", "");
  const result = await session;
  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
});

test("an image to a WORKING pane earns the honest busy beat; to an idle pane it doesn't", async () => {
  const png = Buffer.from([1, 2, 3, 4]);
  const busy = makeHarness({ port: fakeClipboardPort({ text: "", imagePng: png }) });
  const bs = runRelaySession(busy.deps);
  await flush();
  busy.picker.resolve({ kind: "target", target: { ...TARGET_A, agentStatus: "working" } });
  await bs;
  assert.ok(busy.states.some((s) => s.phase === "relay-delivered-busy"),
    "image → working pane is delivered-busy");

  const idle = makeHarness({ port: fakeClipboardPort({ text: "", imagePng: png }) });
  const is = runRelaySession(idle.deps);
  await flush();
  idle.picker.resolve({ kind: "target", target: { ...TARGET_A, agentStatus: "idle" } });
  await is;
  assert.ok(idle.states.some((s) => s.phase === "relay-delivered"),
    "image → idle pane is plain delivered");
  assert.ok(!idle.states.some((s) => s.phase === "relay-delivered-busy"));
});

test("text to a working pane is plain delivered — the busy caveat is image-only", async () => {
  const h = makeHarness({ port: fakeClipboardPort({ text: "just text" }) });
  const s = runRelaySession(h.deps);
  await flush();
  h.picker.resolve({ kind: "target", target: { ...TARGET_A, agentStatus: "working" } });
  await s;
  assert.ok(h.states.some((x) => x.phase === "relay-delivered"));
  assert.ok(!h.states.some((x) => x.phase === "relay-delivered-busy"));
});
