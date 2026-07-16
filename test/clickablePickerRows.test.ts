import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";

import type { CaptureArtifact } from "../src/capture";
import {
  createCapturePickerHandle,
  type PickerRowClick,
  type RowClickSource,
} from "../src/capturePickerHandle";
import { runCaptureSession } from "../src/captureSession";
import type { EligibleTarget } from "../src/herdr";
import type { OverlaySnapshot } from "../src/overlay";

// Clickable picker rows (issue #61, ADR 0005): a mouse click is another way
// to press the row's key — the same selection event, through the same
// one-selection-at-a-time channel, down the identical delivery path. These
// prove the vertical slice end-to-end over the REAL picker handle and the
// REAL session loop (only shortcuts and the click IPC are faked, exactly the
// injected-source seam main.ts uses), plus the main/preload/renderer wiring
// the unit seams can't reach.

const rootDir = path.join(__dirname, "..");

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

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function makeFakeShortcuts() {
  const callbacks = new Map<string, () => void>();
  return {
    register(accelerator: string, callback: () => void) {
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister(accelerator: string) {
      callbacks.delete(accelerator);
    },
    press(accelerator: string) {
      callbacks.get(accelerator)!();
    },
  };
}

/**
 * main.ts's click-source shape verbatim (the activeCropEmit precedent): one
 * module-level emit, set on subscribe, nulled on unsubscribe only if still
 * this instance's — the instance binding that drops stale clicks.
 */
function makeMainStyleClickSource(): {
  source: RowClickSource;
  click(click: PickerRowClick): void;
  emitIsLive(): boolean;
} {
  let activeEmit: ((click: PickerRowClick) => void) | null = null;
  return {
    source: (emit) => {
      activeEmit = emit;
      return () => {
        if (activeEmit === emit) activeEmit = null;
      };
    },
    click(click) {
      activeEmit?.(click);
    },
    emitIsLive: () => activeEmit !== null,
  };
}

// ---------------------------------------------------------------------------
// End-to-end: a click delivers through the identical path a digit press does
// ---------------------------------------------------------------------------

test("a target-row click delivers through the identical path its digit press does — zero new delivery code", async () => {
  const shortcuts = makeFakeShortcuts();
  const clickWire = makeMainStyleClickSource();
  const delivered: EligibleTarget[] = [];

  const session = runCaptureSession({
    showOverlay() {},
    captureActiveWindow: async () => ARTIFACT,
    openPicker: () =>
      createCapturePickerHandle({ shortcuts, clickSource: clickWire.source }),
    queryEligibleTargets: async () => ({
      kind: "targets",
      targets: [TARGET_A, TARGET_B],
    }),
    deliver: async (_artifact, target) => {
      delivered.push(target);
      return { kind: "delivered" };
    },
  });
  await flush();

  // slotIndex 1 is the row digit 3 keys — pane B.
  clickWire.click({ kind: "target", slotIndex: 1 });
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_B });
  assert.deepEqual(delivered, [TARGET_B]);
});

test("a slot-1 click lands the clipboard outcome, exactly as pressing 1 does", async () => {
  const shortcuts = makeFakeShortcuts();
  const clickWire = makeMainStyleClickSource();
  let copied = 0;

  const session = runCaptureSession({
    showOverlay() {},
    captureActiveWindow: async () => ARTIFACT,
    openPicker: () =>
      createCapturePickerHandle({ shortcuts, clickSource: clickWire.source }),
    queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET_A] }),
    copyToClipboard: () => {
      copied += 1;
    },
    deliver: async () => ({ kind: "delivered" }),
  });
  await flush();

  clickWire.click({ kind: "clipboard" });
  const result = await session;

  assert.deepEqual(result, { kind: "clipboard-delivered" });
  assert.equal(copied, 1);
});

test("a live again-row click confirms to the reconciled Last Target; an unmarked one is the same truthful no-op its key produces", async () => {
  // Live: the remembered pane survives the reconcile — the click delivers to
  // the FRESH entry, exactly as the verb-key confirm does.
  {
    const shortcuts = makeFakeShortcuts();
    const clickWire = makeMainStyleClickSource();
    const delivered: EligibleTarget[] = [];
    const freshA: EligibleTarget = { ...TARGET_A, label: "claude · working — pane a" };

    const session = runCaptureSession({
      showOverlay() {},
      captureActiveWindow: async () => ARTIFACT,
      openPicker: () =>
        createCapturePickerHandle({ shortcuts, clickSource: clickWire.source }),
      queryEligibleTargets: async () => ({
        kind: "targets",
        targets: [freshA, TARGET_B],
      }),
      deliver: async (_artifact, target) => {
        delivered.push(target);
        return { kind: "delivered" };
      },
      again: { readLastTarget: () => TARGET_A, hotkeyLabel: "Ctrl+Shift+`" },
    });
    await flush();

    clickWire.click({ kind: "again" });
    const result = await session;

    assert.deepEqual(result, { kind: "target-delivered", target: freshA });
    assert.deepEqual(delivered, [freshA]);
  }

  // Unmarked: the reconcile dropped the remembered pane — the click delivers
  // nothing, refuses nothing, and the picker keeps waiting (the unmark on
  // screen is the explanation). A digit still works after it.
  {
    const shortcuts = makeFakeShortcuts();
    const clickWire = makeMainStyleClickSource();
    const states: OverlaySnapshot[] = [];
    const delivered: EligibleTarget[] = [];

    const session = runCaptureSession({
      showOverlay(snapshot) {
        states.push(snapshot);
      },
      captureActiveWindow: async () => ARTIFACT,
      openPicker: () =>
        createCapturePickerHandle({ shortcuts, clickSource: clickWire.source }),
      queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET_B] }),
      deliver: async (_artifact, target) => {
        delivered.push(target);
        return { kind: "delivered" };
      },
      again: { readLastTarget: () => TARGET_A, hotkeyLabel: "Ctrl+Shift+`" },
    });
    await flush();
    assert.equal(
      states.filter((s) => s.phase === "capture-picker").at(-1)!.againRow!.state,
      "unmarked",
    );

    clickWire.click({ kind: "again" });
    await flush();
    assert.deepEqual(delivered, [], "an unmarked row's click delivers nothing");
    assert.ok(states.every((s) => s.phase !== "refused"), "…and refuses nothing");

    shortcuts.press("2");
    const result = await session;
    assert.deepEqual(result, { kind: "target-delivered", target: TARGET_B });
  }
});

test("keyboard is untouched by the click source: digits, Esc, and the again-confirm behave identically with it wired", async () => {
  const shortcuts = makeFakeShortcuts();
  const clickWire = makeMainStyleClickSource();
  const delivered: EligibleTarget[] = [];

  const session = runCaptureSession({
    showOverlay() {},
    captureActiveWindow: async () => ARTIFACT,
    openPicker: () =>
      createCapturePickerHandle({ shortcuts, clickSource: clickWire.source }),
    queryEligibleTargets: async () => ({
      kind: "targets",
      targets: [TARGET_A, TARGET_B],
    }),
    deliver: async (_artifact, target) => {
      delivered.push(target);
      return { kind: "delivered" };
    },
  });
  await flush();

  shortcuts.press("2");
  const result = await session;

  assert.deepEqual(result, { kind: "target-delivered", target: TARGET_A });
  assert.deepEqual(delivered, [TARGET_A]);
});

// ---------------------------------------------------------------------------
// Stale clicks: the instance binding drops them on every exit path
// ---------------------------------------------------------------------------

test("a click after the picker closes is dropped by the unsubscribe — it can never resurrect a closed picker", async () => {
  const shortcuts = makeFakeShortcuts();
  const clickWire = makeMainStyleClickSource();
  const delivered: EligibleTarget[] = [];
  const states: OverlaySnapshot[] = [];

  const session = runCaptureSession({
    showOverlay(snapshot) {
      states.push(snapshot);
    },
    captureActiveWindow: async () => ARTIFACT,
    openPicker: () =>
      createCapturePickerHandle({ shortcuts, clickSource: clickWire.source }),
    queryEligibleTargets: async () => ({ kind: "targets", targets: [TARGET_A] }),
    deliver: async (_artifact, target) => {
      delivered.push(target);
      return { kind: "delivered" };
    },
  });
  await flush();
  assert.equal(clickWire.emitIsLive(), true, "the source is live while the picker is open");

  shortcuts.press("Escape");
  const result = await session;
  assert.equal(result.kind, "cancelled");
  assert.equal(
    clickWire.emitIsLive(),
    false,
    "close unsubscribed the click source — main's emit is null again",
  );

  const statesAtEnd = states.length;
  clickWire.click({ kind: "target", slotIndex: 0 });
  await flush();
  assert.deepEqual(delivered, [], "the stale click delivered nothing");
  assert.equal(states.length, statesAtEnd, "…and mutated nothing");
});

test("a stale click from a previous picker instance never selects in a fresh one it wasn't born in", async () => {
  // Two sequential pickers over the SAME main-style source (the app's real
  // shape: one module-level emit, one picker at a time via the verb lock).
  const clickWire = makeMainStyleClickSource();

  const first = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    clickSource: clickWire.source,
  });
  first.appendTargets([TARGET_A, TARGET_B]);
  first.close();

  const second = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    clickSource: clickWire.source,
  });
  second.appendTargets([TARGET_A]);

  let resolved: unknown = null;
  void second.awaitSelection().then((event) => {
    resolved = event;
  });

  // A click minted against the FIRST render's list (slot index 1 existed
  // there; the fresh render has one target) is dropped, not misresolved.
  clickWire.click({ kind: "target", slotIndex: 1 });
  await flush();
  assert.equal(resolved, null, "the out-of-range stale click selected nothing");

  // The fresh picker still answers to a click born from ITS render.
  clickWire.click({ kind: "target", slotIndex: 0 });
  await flush();
  assert.deepEqual(resolved, { kind: "target", target: TARGET_A });
  second.close();
});

// ---------------------------------------------------------------------------
// Wiring: main, preload, and the renderer (house source-assertion pattern)
// ---------------------------------------------------------------------------

test("main wires the click source into BOTH pickers, mirrors the crop-source instance binding, and gates bar-clicked through the pure route", () => {
  const main = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");

  // The injected source, same shape as activeCropEmit/pickerAgainSource.
  assert.match(main, /let activeRowClickEmit/);
  assert.match(main, /const pickerRowClickSource: RowClickSource/);
  assert.match(main, /if \(activeRowClickEmit === emit\) activeRowClickEmit = null/);
  // Clicks arrive over IPC carrying the row identity.
  assert.match(main, /ipcMain\.on\("picker-row-clicked"/);
  assert.match(main, /activeRowClickEmit\?\.\(click\)/);
  // Both picker factories inject it — Capture/Herald's and Relay's.
  assert.equal(
    (main.match(/clickSource: pickerRowClickSource/g) ?? []).length,
    2,
    "openCapturePicker and openRelayPicker both wire the click source",
  );
  // The bar click routes through the pure decision, never inline logic.
  assert.match(main, /routeBarClick\(\{ pickerOpen: activeRowClickEmit !== null \}\)/);
  assert.doesNotMatch(
    main,
    /ipcMain\.on\("bar-clicked", \(\) => jumpToLongestBlocked\(\)\)/,
    "the ungated jump call is gone",
  );
});

test("preload exposes the row-click IPC beside the crop and jump sends", () => {
  const preload = readFileSync(path.join(rootDir, "public", "preload.js"), "utf8");

  assert.match(preload, /sendPickerRowClick/);
  assert.match(preload, /picker-row-clicked/);
});

test("renderer: rows are buttons only while a picker is open — affordances, click identities, and passthrough are all renderer-owned", () => {
  const renderer = readFileSync(
    path.join(rootDir, "public", "overlay-renderer.js"),
    "utf8",
  );

  // Renderer-owned style (overlay.html is a Claude Design asset): the entries
  // column becomes pointer-interactive ONLY in the picker state — the design
  // asset ships it pointer-events: none — with cursor/hover/pressed on rows.
  assert.match(
    renderer,
    /\.mf-state-capture-picker #capture-picker-entries \{ pointer-events: auto; \}/,
  );
  assert.match(renderer, /\.mf-state-capture-picker \.capture-picker-entry \{ cursor: pointer; \}/);
  assert.match(renderer, /\.capture-picker-entry:hover/);
  assert.match(renderer, /\.capture-picker-entry:active/);

  // Every key-cap row ships its identity, bound to the render that built it:
  // the again-row, slot 1 where present, and each target row by slot index.
  assert.match(renderer, /makeRowClickable\(.*\{ kind: "again" \}\)/);
  assert.match(renderer, /makeRowClickable\(.*\{ kind: "clipboard" \}\)/);
  assert.match(renderer, /makeRowClickable\(.*\{ kind: "target", slotIndex: index \}\)/);
  assert.match(renderer, /sendPickerRowClick\(identity\)/);

  // Hovering a row keeps the overlay mouse-interactive (the container is
  // display:none outside the picker phase, so at rest this can never match —
  // passthrough returns to today's behavior on close).
  assert.match(renderer, /pickerEntriesEl\.contains\(target\)/);

  // Rows never join the window-drag gesture: the drag targets stay exactly
  // the card and the mascot — the butler/header remains the window handle.
  assert.match(renderer, /for \(const dragTarget of \[cardEl, mascotEl\]\)/);
});
