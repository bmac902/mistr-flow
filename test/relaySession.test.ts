import assert from "node:assert/strict";
import test from "node:test";

import {
  runRelaySession,
  RELAY_HERDR_DOWN_MESSAGE,
  RELAY_NO_PANES_MESSAGE,
  type RunRelaySessionDependencies,
} from "../src/relaySession";
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
  createHerdrDeliveryAdapter,
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

// End-to-end Relay verb (issue #39, PRD #24): the clipboard source (#38) driven
// through the shared send session (#37). These prove the wiring's acceptance
// criteria — the empty state, the Clipboard-less 2–9 picker with a preview,
// delivery via the payload-agnostic adapter, and the truthful Herdr-down state.

const CAPTURE_DIR = "/tmp/MistrFlowCaptures";

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

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- Fake clipboard port (mirrors clipboardSource.test.ts) ------------------

function fakeClipboardPort(options: {
  text?: string;
  imagePng?: Buffer | null;
  filePath?: string | null;
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
    readFilePath: () => options.filePath ?? null,
    writeFile: async () => {},
    mintId: () => `relay-id-${++minted}`,
    timestampIso: () => "2026-07-16T09:00:00.000Z",
    captureDir: CAPTURE_DIR,
  };
}

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

test("copying text opens a Clipboard-less picker (slot 1 skipped) with a text preview and panes on 2–9", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "const x = 1;\nconst y = 2;" }),
  });

  const session = runRelaySession(h.deps);
  await flush();

  const picker = h.states.find((s) => s.phase === "capture-picker");
  assert.ok(picker, "the picker phase was rendered");
  assert.equal(picker!.clipboardSlot, false, "slot 1 (Clipboard) is skipped for Relay");
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
// Herdr unavailable — nowhere to send it
// ---------------------------------------------------------------------------

test("Herdr unavailable renders the nowhere-to-send-it state with no target list, dismissed by Esc", async () => {
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
  // Relay's own copy — never Herdr's "Clipboard only" promise, which Relay can't keep.
  assert.equal(downState!.toastCopy, RELAY_HERDR_DOWN_MESSAGE);
  assert.deepEqual(downState!.captureTargets, [], "no target list");
  assert.equal(downState!.clipboardSlot, false, "and no Clipboard slot either");
  assert.equal(downState!.pickerSummoning, false, "not stuck on the summoning beat");

  // No auto-fade: it waits for Esc.
  h.picker.resolve({ kind: "escape" });
  const result = await session;
  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(h.picker.closeCalls(), 1, "picker closed cleanly on dismiss");
});

test("Herdr up but with no eligible panes is a truthful no-panes state, not a stuck summon", async () => {
  const h = makeHarness({
    port: fakeClipboardPort({ text: "copied url" }),
    queryEligibleTargets: async () => ({ kind: "targets", targets: [] }),
  });

  const session = runRelaySession(h.deps);
  await flush();

  const state = h.states.filter((s) => s.phase === "capture-picker").at(-1);
  assert.equal(state!.toastCopy, RELAY_NO_PANES_MESSAGE);
  assert.equal(state!.pickerSummoning, false);

  h.picker.resolve({ kind: "escape" });
  await session;
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
