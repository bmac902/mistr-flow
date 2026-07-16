import type { ThumbnailSize } from "./captureThumbnail";

// Capture crop: trim a capture down to the part worth sending, so a window
// carrying something you don't want to send (an API key above the thing you
// actually mean) can still be used.
//
// Selection happens on the picker's preview rather than as a snipping-tool
// pass over the live desktop. That is a deliberate trade: the grab is already
// frozen and full-resolution, so cropping it needs no screen freeze and — the
// deciding factor — no coordinate/DPI math across a mixed-DPI, mixed-
// orientation virtual desktop. Precision is bounded by the preview's size,
// which is why the crop is applied to the ORIGINAL pixels and the result is
// shown back immediately.

/**
 * A crop rect in **normalized image space** (0..1, relative to the image's own
 * content — not the preview box, and not the screen). Normalized deliberately:
 * it decouples the renderer's display size from the crop math, so growing the
 * preview later changes nothing here.
 */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Drags smaller than this fraction of the image are treated as a stray click,
 * not a crop — a mis-click must never silently shrink a capture to nothing.
 */
export const MIN_CROP_FRACTION = 0.02;

/** The image operations a crop needs, mirroring Electron's `nativeImage`. */
export interface CropImagePort {
  getSize(): ThumbnailSize;
  crop(rect: PixelRect): CropImagePort;
  toPNG(): Buffer;
  isEmpty(): boolean;
}

export type CropImageLoader = (pngPath: string) => CropImagePort;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Normalizes a drag into a well-formed rect: orders the corners (so dragging
 * up-left works the same as down-right) and clamps into the image.
 */
export function normalizeCropRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
): CropRect {
  const x1 = clamp01(start.x);
  const y1 = clamp01(start.y);
  const x2 = clamp01(end.x);
  const y2 = clamp01(end.y);

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** A crop worth acting on — anything smaller is a click, not a selection. */
export function isMeaningfulCrop(rect: CropRect): boolean {
  return rect.width >= MIN_CROP_FRACTION && rect.height >= MIN_CROP_FRACTION;
}

/**
 * Projects a normalized rect onto real pixels, clamped inside the image and
 * always at least 1x1 so a degenerate rect can't produce an invalid crop.
 */
export function toPixelRect(rect: CropRect, size: ThumbnailSize): PixelRect {
  const x = Math.round(clamp01(rect.x) * size.width);
  const y = Math.round(clamp01(rect.y) * size.height);
  const maxWidth = Math.max(1, size.width - x);
  const maxHeight = Math.max(1, size.height - y);

  return {
    x,
    y,
    width: Math.min(Math.max(1, Math.round(rect.width * size.width)), maxWidth),
    height: Math.min(Math.max(1, Math.round(rect.height * size.height)), maxHeight),
  };
}

/**
 * Crops a capture's PNG, returning the cropped bytes. Best-effort: any
 * failure returns null and the caller keeps the uncropped capture — a bad
 * crop must never cost the user their grab.
 */
export function cropCaptureImage(
  load: CropImageLoader,
  pngPath: string,
  rect: CropRect,
): Buffer | null {
  try {
    if (!isMeaningfulCrop(rect)) return null;

    const image = load(pngPath);
    if (image.isEmpty()) return null;

    const cropped = image.crop(toPixelRect(rect, image.getSize()));
    if (cropped.isEmpty()) return null;

    const png = cropped.toPNG();
    return png.length > 0 ? png : null;
  } catch {
    return null;
  }
}
