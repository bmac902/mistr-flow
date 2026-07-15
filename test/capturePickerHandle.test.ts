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
