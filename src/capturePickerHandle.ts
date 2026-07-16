import type { CropRect } from "./captureCrop";
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

/**
 * Subscribes to crop drags from the renderer, returning an unsubscribe. Crops
 * arrive over IPC rather than as accelerators — a rectangle isn't a keypress —
 * but they resolve the same one-selection-at-a-time channel as the digits, so
 * the orchestrator sees a single ordered event stream either way.
 */
export type CropSource = (emit: (rect: CropRect) => void) => () => void;

export interface CapturePickerHandleDeps {
  readonly shortcuts: GlobalShortcutPort;
  readonly cropSource?: CropSource;
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
  const { shortcuts, cropSource } = deps;
  const registeredAccelerators = new Set<string>();
  let pendingResolve: ((event: CaptureSelectionEvent) => void) | null = null;
  let closed = false;
  let unsubscribeCrop: (() => void) | null = null;

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

  if (cropSource) {
    unsubscribeCrop = cropSource((rect) => resolveSelection({ kind: "crop", rect }));
  }

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

      unsubscribeCrop?.();
      unsubscribeCrop = null;

      for (const accelerator of registeredAccelerators) {
        shortcuts.unregister(accelerator);
      }
      registeredAccelerators.clear();
    },
  };
}
