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

/**
 * Subscribes the verb's own hotkey as the again-confirm (issue #58, ADR 0004),
 * returning an unsubscribe. The verb hotkeys stay registered globally in
 * main.ts — a picker never re-registers them — so, like crops, the press
 * arrives from outside and resolves the same one-selection-at-a-time channel
 * the digits use: one ordered event stream, whatever the input.
 */
export type AgainSource = (emit: () => void) => () => void;

/**
 * A row click's identity as the renderer reported it (issue #61, ADR 0005) —
 * the slot kind, plus the 0-based position in the appended target list for
 * pane rows (digit = slotIndex + 2). Identity, never payload: the handle
 * resolves it against the rows THIS instance registered, so a click can never
 * act on a stale or reordered target list.
 */
export type PickerRowClick =
  | { readonly kind: "clipboard" }
  | { readonly kind: "target"; readonly slotIndex: number }
  | { readonly kind: "again" };

/**
 * Subscribes to picker-row clicks from the renderer (issue #61, ADR 0005),
 * returning an unsubscribe. A mouse click is another way to press the row's
 * key, never a second implementation: like crops and again-confirms it
 * arrives from outside as an injected source and resolves the EXACT selection
 * event the row's key produces, through the same one-selection-at-a-time
 * channel — ledger, unknown → retry, slot-1 semantics and again-resolution
 * all inherited, not re-implemented.
 */
export type RowClickSource = (emit: (click: PickerRowClick) => void) => () => void;

/**
 * Subscribes an external cancel (verb-switch, 2026-07-17), returning an
 * unsubscribe. When a *different* verb's hotkey lands while this picker is
 * open, main.ts cancels the picker through this source and starts the
 * intended verb — the emit dispatches the EXACT escape event the Esc key
 * produces, through the same one-selection-at-a-time channel: one ordered
 * event stream, whatever the input (the crop/again/click pattern).
 */
export type CancelSource = (emit: () => void) => () => void;

/**
 * Subscribes to capture-history navigation (issue #95), returning an
 * unsubscribe. Left/Right arrow through the last-N captures; the arrows
 * themselves are `globalShortcut`s this handle registers (the renderer can't
 * take keyboard input — main.ts:1412/1421), but the same navigation also
 * arrives through this injected seam so it is provable without a keyboard,
 * exactly as `cropSource`/`againSource`/`clickSource`/`cancelSource` are. It
 * resolves the same one-selection-at-a-time channel: one ordered event stream,
 * whatever the input.
 */
export type HistorySource = (
  emit: (direction: "older" | "newer") => void,
) => () => void;

export interface CapturePickerHandleDeps {
  readonly shortcuts: GlobalShortcutPort;
  readonly cropSource?: CropSource;
  readonly againSource?: AgainSource;
  readonly clickSource?: RowClickSource;
  readonly cancelSource?: CancelSource;
  readonly historySource?: HistorySource;
  /**
   * Whether digit `1` resolves to the pinned local-outcome slot. True for
   * every verb since #64 (slot 1 is always "end this locally, no pane" —
   * CONTEXT.md); `false` remains the handle's contract for a slot-1-less
   * picker, though no verb builds one today. Panes start at digit 2 either
   * way, so the "2 is always the same pane" muscle memory holds regardless.
   */
  readonly includeClipboardSlot?: boolean;
}

/**
 * Registers Esc and slot 1 (the local outcome — every verb since #64)
 * atomically on open, then registers slots 2–9 atomically with each
 * `appendTargets` call — no digit shortcut is ever live before its entry is
 * renderable, and vice versa. Unregisters every accelerator it registered on
 * `close()`, on every exit path.
 */
export function createCapturePickerHandle(
  deps: CapturePickerHandleDeps,
): CapturePickerHandle {
  const { shortcuts, cropSource, againSource, clickSource, cancelSource, historySource } =
    deps;
  const includeClipboardSlot = deps.includeClipboardSlot ?? true;
  const registeredAccelerators = new Set<string>();
  // The targets THIS instance put on digit slots, in append order — the sole
  // thing a row click's slotIndex is resolved against, so a click bound to a
  // stale render can never select in a list it wasn't born from.
  const slotTargets: EligibleTarget[] = [];
  let pendingResolve: ((event: CaptureSelectionEvent) => void) | null = null;
  let closed = false;
  let unsubscribeCrop: (() => void) | null = null;
  let unsubscribeAgain: (() => void) | null = null;
  let unsubscribeClick: (() => void) | null = null;
  let unsubscribeCancel: (() => void) | null = null;
  let unsubscribeHistory: (() => void) | null = null;

  function resolveSelection(event: CaptureSelectionEvent): void {
    if (closed || !pendingResolve) return;
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(event);
  }

  /**
   * A row click is a press of the row's key (issue #61, ADR 0005): it maps to
   * the identical selection event, or is dropped when no such row exists in
   * this instance — a clipboard click into a picker built without slot 1
   * (no verb since #64), or a slot index the current render never populated.
   */
  function resolveRowClick(click: PickerRowClick): void {
    if (click.kind === "clipboard") {
      if (!includeClipboardSlot) return;
      resolveSelection({ kind: "clipboard" });
      return;
    }
    if (click.kind === "again") {
      resolveSelection({ kind: "again" });
      return;
    }
    const target = slotTargets[click.slotIndex];
    if (!target) return;
    resolveSelection({ kind: "target", target });
  }

  function registerAccelerator(accelerator: string, onPress: () => void): void {
    if (shortcuts.register(accelerator, onPress)) {
      registeredAccelerators.add(accelerator);
    }
  }

  // Electron treats the numpad as its own key space (`num1`…`num9`), so every
  // digit slot registers both forms — the top row and the keypad are the same
  // key to a human hand (dogfood 2026-07-17).
  function registerDigit(digit: number, onPress: () => void): void {
    registerAccelerator(String(digit), onPress);
    registerAccelerator(`num${digit}`, onPress);
  }

  if (includeClipboardSlot) {
    registerDigit(1, () => resolveSelection({ kind: "clipboard" }));
  }
  registerAccelerator("Escape", () => resolveSelection({ kind: "escape" }));

  if (cropSource) {
    unsubscribeCrop = cropSource((rect) => resolveSelection({ kind: "crop", rect }));
  }

  if (againSource) {
    unsubscribeAgain = againSource(() => resolveSelection({ kind: "again" }));
  }

  if (clickSource) {
    unsubscribeClick = clickSource((click) => resolveRowClick(click));
  }

  if (cancelSource) {
    unsubscribeCancel = cancelSource(() => resolveSelection({ kind: "escape" }));
  }

  // History arrows exist only for a verb with a history ring (Capture #95,
  // Relay #96). Registered like the digits — with the picker's lifetime, in
  // both the plain and (for symmetry with the digit numpad forms) the bare
  // arrow forms Electron exposes — and released on every close path, so a
  // leaked system-wide arrow grab can't outlive the picker. The injected
  // source carries the same navigation for the sandbox, where no key fires.
  if (historySource) {
    registerAccelerator("Left", () =>
      resolveSelection({ kind: "navigate", direction: "older" }),
    );
    registerAccelerator("Right", () =>
      resolveSelection({ kind: "navigate", direction: "newer" }),
    );
    unsubscribeHistory = historySource((direction) =>
      resolveSelection({ kind: "navigate", direction }),
    );
  }

  return {
    appendTargets(targets: readonly EligibleTarget[]): void {
      if (closed) return;

      for (const [index, target] of targets.slice(0, MAX_TARGET_SLOTS).entries()) {
        const digit = index + 2;
        slotTargets[index] = target;
        registerDigit(digit, () => resolveSelection({ kind: "target", target }));
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

      unsubscribeAgain?.();
      unsubscribeAgain = null;

      unsubscribeClick?.();
      unsubscribeClick = null;

      unsubscribeCancel?.();
      unsubscribeCancel = null;

      unsubscribeHistory?.();
      unsubscribeHistory = null;

      for (const accelerator of registeredAccelerators) {
        shortcuts.unregister(accelerator);
      }
      registeredAccelerators.clear();
    },
  };
}
