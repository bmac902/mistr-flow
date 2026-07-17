import assert from "node:assert/strict";
import test from "node:test";

import { createCapturePickerHandle, type PickerRowClick } from "../src/capturePickerHandle";
import type { EligibleTarget } from "../src/herdr";

const TARGET_A: EligibleTarget = {
  target: "herdr-session-a",
  label: "claude · idle — pane a",
  agentStatus: "idle",
  agent: "claude",
  cwd: null,
};

const TARGET_B: EligibleTarget = {
  target: "herdr-session-b",
  label: "claude · working — pane b",
  agentStatus: "working",
  agent: "claude",
  cwd: null,
};

interface FakeShortcuts {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  registeredAccelerators(): string[];
  press(accelerator: string): void;
}

function makeFakeShortcuts(): FakeShortcuts {
  const callbacks = new Map<string, () => void>();
  return {
    register(accelerator, callback) {
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      callbacks.delete(accelerator);
    },
    registeredAccelerators() {
      return [...callbacks.keys()];
    },
    press(accelerator) {
      const callback = callbacks.get(accelerator);
      if (!callback) throw new Error(`no shortcut registered for "${accelerator}"`);
      callback();
    },
  };
}

test("createCapturePickerHandle: opening registers slot 1 + Esc atomically", () => {
  const shortcuts = makeFakeShortcuts();
  createCapturePickerHandle({ shortcuts });

  assert.deepEqual(shortcuts.registeredAccelerators().sort(), ["1", "Escape"]);
});

test("createCapturePickerHandle: appendTargets registers slots 2-9 atomically", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });

  handle.appendTargets([TARGET_A, TARGET_B]);

  assert.deepEqual(shortcuts.registeredAccelerators().sort(), [
    "1",
    "2",
    "3",
    "Escape",
  ]);
});

test("createCapturePickerHandle: appendTargets caps at 8 target slots (digits 2-9)", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });

  const nineTargets = Array.from({ length: 9 }, (_, i) => ({
    target: `herdr-session-${i}`,
    label: `agent ${i}`,
    agentStatus: "idle" as const,
    agent: "claude",
    cwd: null,
  }));
  handle.appendTargets(nineTargets);

  assert.deepEqual(
    shortcuts.registeredAccelerators().sort(),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Escape"],
  );
});

test("createCapturePickerHandle: pressing 1 resolves awaitSelection with clipboard", async () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });

  const selection = handle.awaitSelection();
  shortcuts.press("1");

  assert.deepEqual(await selection, { kind: "clipboard" });
});

test("createCapturePickerHandle: pressing Escape resolves awaitSelection with escape", async () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });

  const selection = handle.awaitSelection();
  shortcuts.press("Escape");

  assert.deepEqual(await selection, { kind: "escape" });
});

test("createCapturePickerHandle: pressing a target digit resolves awaitSelection with that target", async () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });
  handle.appendTargets([TARGET_A, TARGET_B]);

  const selection = handle.awaitSelection();
  shortcuts.press("3");

  assert.deepEqual(await selection, { kind: "target", target: TARGET_B });
});

test("createCapturePickerHandle: awaitSelection supports sequential retries", async () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });
  handle.appendTargets([TARGET_A]);

  const first = handle.awaitSelection();
  shortcuts.press("2");
  assert.deepEqual(await first, { kind: "target", target: TARGET_A });

  const second = handle.awaitSelection();
  shortcuts.press("2");
  assert.deepEqual(await second, { kind: "target", target: TARGET_A });
});

test("createCapturePickerHandle: a press with no pending awaitSelection is a harmless no-op", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });
  handle.appendTargets([TARGET_A]);

  assert.doesNotThrow(() => shortcuts.press("2"));
});

test("createCapturePickerHandle: close unregisters every accelerator exactly once", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });
  handle.appendTargets([TARGET_A, TARGET_B]);

  handle.close();
  assert.deepEqual(shortcuts.registeredAccelerators(), []);

  assert.doesNotThrow(() => handle.close());
});

test("createCapturePickerHandle: appendTargets after close is a no-op", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });
  handle.close();

  handle.appendTargets([TARGET_A]);

  assert.deepEqual(shortcuts.registeredAccelerators(), []);
});

test("crop drags from the renderer resolve the same selection channel as digits", () => {
  let emit: ((rect: { x: number; y: number; width: number; height: number }) => void) | null = null;
  let unsubscribed = false;
  const handle = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    cropSource: (cb) => {
      emit = cb;
      return () => {
        unsubscribed = true;
      };
    },
  });

  const selection = handle.awaitSelection();
  const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
  emit!(rect);

  return selection.then((event) => {
    assert.deepEqual(event, { kind: "crop", rect });

    // The subscription is torn down with everything else on close — a crop
    // must never resolve a closed picker.
    handle.close();
    assert.equal(unsubscribed, true);
  });
});

test("a picker with no cropSource still works", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });

  const selection = handle.awaitSelection();
  shortcuts.press("1");

  return selection.then((event) => {
    assert.deepEqual(event, { kind: "clipboard" });
    handle.close();
  });
});

// --- Same agent again: the verb-key confirm (issue #58, ADR 0004) ----------

test("an again press from the verb hotkey resolves the same selection channel as digits", async () => {
  let emit: (() => void) | null = null;
  let unsubscribed = false;
  const handle = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    againSource: (cb) => {
      emit = cb;
      return () => {
        unsubscribed = true;
      };
    },
  });

  const selection = handle.awaitSelection();
  emit!();

  assert.deepEqual(await selection, { kind: "again" });

  // Torn down with everything else on close — a stray verb-key press must
  // never resolve a closed picker.
  handle.close();
  assert.equal(unsubscribed, true);
});

test("an again press with no pending awaitSelection is a harmless no-op (e.g. mid-delivery)", () => {
  let emit: (() => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    againSource: (cb) => {
      emit = cb;
      return () => {};
    },
  });

  // No awaitSelection outstanding — exactly the delivering beat, where digit
  // presses are already structural no-ops. The again press joins that rule.
  assert.doesNotThrow(() => emit!());
  handle.close();
});

test("a picker with no againSource still works", async () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });

  const selection = handle.awaitSelection();
  shortcuts.press("Escape");

  assert.deepEqual(await selection, { kind: "escape" });
});

// --- Clickable rows: the injected click source (issue #61, ADR 0005) -------
// A mouse click is another way to press the row's key, never a second
// implementation: a click resolves the EXACT selection event the key
// produces, through the same one-selection-at-a-time channel.

test("a slot-1 click resolves the identical clipboard event pressing 1 produces", async () => {
  const shortcuts = makeFakeShortcuts();
  let click: ((c: PickerRowClick) => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts,
    clickSource: (cb) => {
      click = cb;
      return () => {};
    },
  });

  const byKey = handle.awaitSelection();
  shortcuts.press("1");
  const byClick = handle.awaitSelection();
  click!({ kind: "clipboard" });

  assert.deepEqual(await byClick, await byKey);
  assert.deepEqual(await byClick, { kind: "clipboard" });
});

test("a target-row click resolves the identical selection event its digit produces", async () => {
  const shortcuts = makeFakeShortcuts();
  let click: ((c: PickerRowClick) => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts,
    clickSource: (cb) => {
      click = cb;
      return () => {};
    },
  });
  handle.appendTargets([TARGET_A, TARGET_B]);

  // slotIndex 1 is the second appended target — the row the digit 3 keys.
  const byKey = handle.awaitSelection();
  shortcuts.press("3");
  const byClick = handle.awaitSelection();
  click!({ kind: "target", slotIndex: 1 });

  assert.deepEqual(await byClick, await byKey);
  assert.deepEqual(await byClick, { kind: "target", target: TARGET_B });
});

test("an again-row click resolves the identical again event the verb key produces", async () => {
  let againEmit: (() => void) | null = null;
  let click: ((c: PickerRowClick) => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    againSource: (cb) => {
      againEmit = cb;
      return () => {};
    },
    clickSource: (cb) => {
      click = cb;
      return () => {};
    },
  });

  const byKey = handle.awaitSelection();
  againEmit!();
  const byClick = handle.awaitSelection();
  click!({ kind: "again" });

  assert.deepEqual(await byClick, await byKey);
  assert.deepEqual(await byClick, { kind: "again" });
});

test("a click on a slot the current render never populated is dropped — never a stale or default target", async () => {
  const shortcuts = makeFakeShortcuts();
  let click: ((c: PickerRowClick) => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts,
    clickSource: (cb) => {
      click = cb;
      return () => {};
    },
  });
  handle.appendTargets([TARGET_A]);

  const selection = handle.awaitSelection();
  // A click carrying a slot this render never populated (a reordered or
  // shrunken target list) resolves nothing…
  click!({ kind: "target", slotIndex: 5 });
  // …so the channel is still live for the next real input.
  shortcuts.press("2");

  assert.deepEqual(await selection, { kind: "target", target: TARGET_A });
});

test("Relay picker: a slot-1 click resolves the clipboard event — slot 1 returned in #64", async () => {
  // Was #61's "a clipboard click is dropped — Relay renders no slot 1". Slot 1
  // is back ("1 Clipboard" = keep the copy, stop here), so Relay's picker is
  // built WITH the slot and a click on it is a press of `1`.
  const shortcuts = makeFakeShortcuts();
  let click: ((c: PickerRowClick) => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts,
    includeClipboardSlot: true,
    clickSource: (cb) => {
      click = cb;
      return () => {};
    },
  });
  handle.appendTargets([TARGET_A]);

  const selection = handle.awaitSelection();
  click!({ kind: "clipboard" });

  assert.deepEqual(await selection, { kind: "clipboard" });
});

test("a clipboard click into a picker built without slot 1 is dropped — no such row exists", async () => {
  // No verb builds this picker since #64, but the option remains the handle's
  // contract: a click resolves only against rows THIS instance registered.
  const shortcuts = makeFakeShortcuts();
  let click: ((c: PickerRowClick) => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts,
    includeClipboardSlot: false,
    clickSource: (cb) => {
      click = cb;
      return () => {};
    },
  });
  handle.appendTargets([TARGET_A]);

  const selection = handle.awaitSelection();
  click!({ kind: "clipboard" });
  shortcuts.press("2");

  assert.deepEqual(await selection, { kind: "target", target: TARGET_A });
});

test("the click subscription is torn down on close — a stale click never resolves a closed picker", async () => {
  let click: ((c: PickerRowClick) => void) | null = null;
  let unsubscribed = false;
  const handle = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    clickSource: (cb) => {
      click = cb;
      return () => {
        unsubscribed = true;
      };
    },
  });
  handle.appendTargets([TARGET_A]);

  let resolved = false;
  void handle.awaitSelection().then(() => {
    resolved = true;
  });

  handle.close();
  assert.equal(unsubscribed, true, "torn down with everything else on close");

  // Even a click that slips past the unsubscribe (the emit was already in
  // hand) lands on the closed guard and resolves nothing.
  click!({ kind: "target", slotIndex: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "a stale click can never resurrect a closed picker");
});

test("a click with no pending awaitSelection is a harmless no-op (e.g. mid-delivery)", () => {
  let click: ((c: PickerRowClick) => void) | null = null;
  const handle = createCapturePickerHandle({
    shortcuts: makeFakeShortcuts(),
    clickSource: (cb) => {
      click = cb;
      return () => {};
    },
  });
  handle.appendTargets([TARGET_A]);

  // No awaitSelection outstanding — exactly the delivering beat, where digit
  // presses are already structural no-ops. The click joins that rule.
  assert.doesNotThrow(() => click!({ kind: "target", slotIndex: 0 }));
  handle.close();
});

test("a picker with no clickSource still works", async () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts });

  const selection = handle.awaitSelection();
  shortcuts.press("Escape");

  assert.deepEqual(await selection, { kind: "escape" });
});

// --- includeClipboardSlot: false — the option's contract ------------------
// (Built for Relay's original slot-skipping in #39; since #64 slot 1 is the
// local outcome in EVERY verb, so no verb builds a slot-1-less picker today.
// The option stays generic machinery, pinned here.)

test("includeClipboardSlot: false registers only Esc on open — no slot 1", () => {
  const shortcuts = makeFakeShortcuts();
  createCapturePickerHandle({ shortcuts, includeClipboardSlot: false });

  assert.deepEqual(shortcuts.registeredAccelerators(), ["Escape"]);
});

test("includeClipboardSlot: false still puts panes on digits 2-9 — slot 1 is reserved, not compacted", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts, includeClipboardSlot: false });

  handle.appendTargets([TARGET_A, TARGET_B]);

  // No "1": pane A on digit 2, pane B on digit 3 — panes are NOT pulled down
  // to slot 1, so "2 is always the same pane" would hold even for a picker
  // built without the slot.
  assert.deepEqual(shortcuts.registeredAccelerators().sort(), ["2", "3", "Escape"]);
});

test("the same pane sits on the same digit in the Capture and Relay pickers", () => {
  const captureShortcuts = makeFakeShortcuts();
  const relayShortcuts = makeFakeShortcuts();

  // Since #64 both verbs build the identical picker: slot 1 (the local
  // outcome) plus panes on 2–9 — the muscle-memory guarantee ("2 is always
  // the same pane") is now alignment by construction.
  const captureHandle = createCapturePickerHandle({ shortcuts: captureShortcuts });
  const relayHandle = createCapturePickerHandle({
    shortcuts: relayShortcuts,
    includeClipboardSlot: true,
  });

  captureHandle.appendTargets([TARGET_A, TARGET_B]);
  relayHandle.appendTargets([TARGET_A, TARGET_B]);

  const capturePick = captureHandle.awaitSelection();
  captureShortcuts.press("2");
  const relayPick = relayHandle.awaitSelection();
  relayShortcuts.press("2");

  return Promise.all([capturePick, relayPick]).then(([capture, relay]) => {
    assert.deepEqual(capture, { kind: "target", target: TARGET_A });
    assert.deepEqual(relay, { kind: "target", target: TARGET_A });
  });
});

test("includeClipboardSlot: false — pressing 1 is a harmless no-op (never registered)", () => {
  const shortcuts = makeFakeShortcuts();
  createCapturePickerHandle({ shortcuts, includeClipboardSlot: false });

  assert.throws(() => shortcuts.press("1"), /no shortcut registered/);
});
