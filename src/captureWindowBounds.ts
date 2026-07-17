import { OVERLAY_WINDOW_HEIGHT, type OverlayWorkArea } from "./overlayPosition";

// Capture picker grow/restore bounds math (issue #31, PRD #24): pure
// anchor/clamp functions mirroring overlayPosition.ts's compose-then-clamp
// shape. All actual `BrowserWindow.setBounds` I/O stays in main.ts.

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Max Herdr targets the picker renders (digit slots 2–9; mirrors herdr.ts's MAX_ELIGIBLE_TARGETS). */
export const CAPTURE_PICKER_MAX_TARGETS = 8;

/** Placeholder per-entry row height pending the Claude Design treatment (#29). */
export const CAPTURE_PICKER_ENTRY_HEIGHT = 26;

/** Placeholder padding between the resting card and the entry list pending #29. */
export const CAPTURE_PICKER_LIST_PADDING = 8;

/**
 * Vertical budget for the capture preview block (#35): the image box, its
 * caption line, and the frame padding + gap around them. Must stay in sync
 * with #capture-preview's effective CSS — overlay.html's frame plus the
 * renderer's TV-scale overrides (image box 146 → 179 on 2026-07-16, so the
 * original 186 budget grew by the same +33) — the window is sized from here,
 * the DOM lays itself out from there.
 */
export const CAPTURE_PREVIEW_BLOCK_HEIGHT = 219;

/**
 * Headroom for the butler's hat (dogfood 2026-07-17): the renderer's TV-scale
 * override grows the mascot 25% about his feet, so his top extends ~28px above
 * the stage budget the asset shipped with. At rest the resting bounds absorb
 * it; in a *grown* picker the stage is pushed against the window's top edge
 * and the head clips without this. Must cover 0.25 × the asset's 111px mascot.
 */
export const CAPTURE_PICKER_MASCOT_HEADROOM = 32;

/** Digit slot 1 (Clipboard) is always rendered, plus up to 8 Herdr targets. */
export function capturePickerEntryCount(targetCount: number): number {
  return 1 + Math.min(targetCount, CAPTURE_PICKER_MAX_TARGETS);
}

export function capturePickerWindowHeight(
  targetCount: number,
  hasPreview = false,
  hasAgainRow = false,
): number {
  // The again-row (issue #58) is one more real list entry, present from the
  // picker's first frame — budgeted exactly like a digit slot so a full
  // picker never clips its last row.
  return (
    OVERLAY_WINDOW_HEIGHT +
    CAPTURE_PICKER_MASCOT_HEADROOM +
    CAPTURE_PICKER_LIST_PADDING +
    (capturePickerEntryCount(targetCount) + (hasAgainRow ? 1 : 0)) *
      CAPTURE_PICKER_ENTRY_HEIGHT +
    (hasPreview ? CAPTURE_PREVIEW_BLOCK_HEIGHT : 0)
  );
}

// (The former relayPickerWindowHeight alias — Relay's "slot 1 skipped but its
// row reserved" height from #39 — is gone: since #64 slot 1 is the local
// outcome in every verb, so every picker is capturePickerWindowHeight tall.)

/**
 * Grows the resting window bounds upward: the bottom edge and horizontal
 * center of the resting card stay anchored in place, then the grown bounds
 * are clamped into the work area exactly like overlayPosition's clamp. When
 * `grownHeight` equals `restingBounds.height` this returns `restingBounds`
 * exactly (modulo clamping) — the same math a caller uses to restore exact
 * resting bounds on dismiss/failure/completion.
 */
export function resolveGrownWindowBounds({
  restingBounds,
  grownHeight,
  workArea,
}: {
  restingBounds: WindowBounds;
  grownHeight: number;
  workArea: OverlayWorkArea;
}): WindowBounds {
  const width = restingBounds.width;
  const restingBottom = restingBounds.y + restingBounds.height;
  const restingCenterX = restingBounds.x + restingBounds.width / 2;

  const naturalX = Math.round(restingCenterX - width / 2);
  const naturalY = restingBottom - grownHeight;

  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - width);
  const maxY = Math.max(minY, workArea.y + workArea.height - grownHeight);

  return {
    x: clamp(naturalX, minX, maxX),
    y: clamp(naturalY, minY, maxY),
    width,
    height: grownHeight,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
