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
 * Vertical budget for the capture preview block (#35): the 146px image box,
 * its caption line, and the frame padding + gap around them. Must stay in
 * sync with #capture-preview's CSS in overlay.html — the window is sized from
 * here, the DOM lays itself out from there.
 */
export const CAPTURE_PREVIEW_BLOCK_HEIGHT = 186;

/** Digit slot 1 (Clipboard) is always rendered, plus up to 8 Herdr targets. */
export function capturePickerEntryCount(targetCount: number): number {
  return 1 + Math.min(targetCount, CAPTURE_PICKER_MAX_TARGETS);
}

export function capturePickerWindowHeight(
  targetCount: number,
  hasPreview = false,
): number {
  return (
    OVERLAY_WINDOW_HEIGHT +
    CAPTURE_PICKER_LIST_PADDING +
    capturePickerEntryCount(targetCount) * CAPTURE_PICKER_ENTRY_HEIGHT +
    (hasPreview ? CAPTURE_PREVIEW_BLOCK_HEIGHT : 0)
  );
}

/**
 * Relay picker height (issue #39). Slot 1 is *skipped* — the clipboard is the
 * source, so there's no Clipboard destination to pin — but its row is still
 * reserved so panes stay on digits 2–9, keeping the muscle-memory alignment
 * with Capture ("2 is always the same pane"; CONTEXT.md). Reserving the skipped
 * slot is exactly what {@link capturePickerEntryCount}'s leading `1` already
 * counts, so the height is a pure function of the same entry count — extended
 * for the skipped slot rather than hardcoding a new number. Identical to
 * Capture's for the same target count, by construction.
 */
export function relayPickerWindowHeight(
  targetCount: number,
  hasPreview = false,
): number {
  return capturePickerWindowHeight(targetCount, hasPreview);
}

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
