import assert from "node:assert/strict";
import test from "node:test";

import { createCapturePickerHandle } from "../src/capturePickerHandle";
import type { EligibleTarget } from "../src/herdr";

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

// --- Relay: slot 1 skipped (issue #39) -----------------------------------

test("Relay picker (includeClipboardSlot: false) registers only Esc on open — no slot 1", () => {
  const shortcuts = makeFakeShortcuts();
  createCapturePickerHandle({ shortcuts, includeClipboardSlot: false });

  assert.deepEqual(shortcuts.registeredAccelerators(), ["Escape"]);
});

test("Relay picker still puts panes on digits 2-9 — slot 1 is skipped, not compacted", () => {
  const shortcuts = makeFakeShortcuts();
  const handle = createCapturePickerHandle({ shortcuts, includeClipboardSlot: false });

  handle.appendTargets([TARGET_A, TARGET_B]);

  // No "1": pane A on digit 2, pane B on digit 3 — panes are NOT pulled down
  // to slot 1 (CONTEXT.md: the digit is deliberately wasted).
  assert.deepEqual(shortcuts.registeredAccelerators().sort(), ["2", "3", "Escape"]);
});

test("the same pane sits on the same digit in the Capture and Relay pickers", () => {
  const captureShortcuts = makeFakeShortcuts();
  const relayShortcuts = makeFakeShortcuts();

  const captureHandle = createCapturePickerHandle({ shortcuts: captureShortcuts });
  const relayHandle = createCapturePickerHandle({
    shortcuts: relayShortcuts,
    includeClipboardSlot: false,
  });

  captureHandle.appendTargets([TARGET_A, TARGET_B]);
  relayHandle.appendTargets([TARGET_A, TARGET_B]);

  // Digit 2 resolves to TARGET_A in BOTH verbs — the muscle-memory guarantee
  // ("2 is always the same pane") holds because Relay wastes slot 1 rather
  // than compacting panes down to it.
  const capturePick = captureHandle.awaitSelection();
  captureShortcuts.press("2");
  const relayPick = relayHandle.awaitSelection();
  relayShortcuts.press("2");

  return Promise.all([capturePick, relayPick]).then(([capture, relay]) => {
    assert.deepEqual(capture, { kind: "target", target: TARGET_A });
    assert.deepEqual(relay, { kind: "target", target: TARGET_A });
  });
});

test("Relay picker: pressing 1 is a harmless no-op (never registered)", () => {
  const shortcuts = makeFakeShortcuts();
  createCapturePickerHandle({ shortcuts, includeClipboardSlot: false });

  assert.throws(() => shortcuts.press("1"), /no shortcut registered/);
});
