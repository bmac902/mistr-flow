import type { EligibleTarget } from "./herdr";
import type { CapturePickerHandle, CaptureSelectionEvent } from "./captureSession";

// Concrete picker-handle implementation (issue #31, PRD #24): owns
// global-shortcut registration for the picker's digit/Esc input. All
// Electron effects are confined behind the injected GlobalShortcutPort so
// this stays unit-testable with a fake, mirroring the house adapter pattern.

/** Max Herdr targets renderable as digit slots 2–9 (mirrors herdr.ts's MAX_ELIGIBLE_TARGETS). */
const MAX_TARGET_SLOTS = 8;

export interface GlobalShortcutPort {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface CapturePickerHandleDeps {
  readonly shortcuts: GlobalShortcutPort;
}

/**
 * Registers slot 1 (Clipboard) + Esc atomically on open, then registers
 * slots 2–9 atomically with each `appendTargets` call — no digit shortcut is
 * ever live before its entry is renderable, and vice versa. Unregisters
 * every accelerator it registered on `close()`, on every exit path.
 */
export function createCapturePickerHandle(
  deps: CapturePickerHandleDeps,
): CapturePickerHandle {
  const { shortcuts } = deps;
  const registeredAccelerators = new Set<string>();
  let pendingResolve: ((event: CaptureSelectionEvent) => void) | null = null;
  let closed = false;

  function resolveSelection(event: CaptureSelectionEvent): void {
    if (closed || !pendingResolve) return;
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(event);
  }

  function registerAccelerator(accelerator: string, onPress: () => void): void {
    if (shortcuts.register(accelerator, onPress)) {
      registeredAccelerators.add(accelerator);
    }
  }

  registerAccelerator("1", () => resolveSelection({ kind: "clipboard" }));
  registerAccelerator("Escape", () => resolveSelection({ kind: "escape" }));

  return {
    appendTargets(targets: readonly EligibleTarget[]): void {
      if (closed) return;

      for (const [index, target] of targets.slice(0, MAX_TARGET_SLOTS).entries()) {
        const digit = index + 2;
        registerAccelerator(String(digit), () =>
          resolveSelection({ kind: "target", target }),
        );
      }
    },

    awaitSelection(): Promise<CaptureSelectionEvent> {
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      pendingResolve = null;

      for (const accelerator of registeredAccelerators) {
        shortcuts.unregister(accelerator);
      }
      registeredAccelerators.clear();
    },
  };
}
