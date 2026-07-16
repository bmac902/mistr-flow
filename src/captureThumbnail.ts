import type { CaptureArtifact } from "./capture";

// Capture preview thumbnail (issue #35): the picker shows what was actually
// grabbed, so a wrong capture is caught before it reaches a live agent rather
// than after the agent asks "what is this?".
//
// Pure module — the decode/resize/encode I/O is Electron's `nativeImage`,
// injected as a {@link ThumbnailImagePort} so this stays testable with a fake
// (the house pattern: pure logic here, effects in main.ts).
//
// Deliberately NOT built on capture.ts's hand-rolled decodePng: that decoder
// exists only to answer "is this grab empty/black", discards its pixels, and
// throws on palette/interlaced/non-8-bit PNGs. Chromium's decoder behind
// nativeImage handles all of those and can resize and re-encode.

export interface ThumbnailSize {
  readonly width: number;
  readonly height: number;
}

/** The box the preview is fitted into. Mirrored by the CSS frame in overlay.html. */
export const CAPTURE_PREVIEW_BOX: ThumbnailSize = { width: 260, height: 146 };

/** What the renderer needs to draw the preview: the image, and what it is. */
export interface CapturePreview {
  readonly dataUrl: string;
  readonly windowTitle: string;
}

/**
 * The Relay text preview (issue #38/#39): the picker's preview panel shows the
 * first few copied lines plus a one-line summary, exactly as the image preview
 * shows the thumbnail — so you never fire off whatever you copied three hours
 * ago, blind. Lives here beside {@link CapturePreview} because both are the
 * "what the picker previews" contract; {@link readClipboardSource} produces it.
 */
export interface ClipboardTextPreview {
  readonly kind: "text";
  /** The first {@link CLIPBOARD_PREVIEW_LINES} lines, verbatim. */
  readonly firstLines: string;
  /** Whether {@link firstLines} is only the head of a longer body. */
  readonly truncated: boolean;
  readonly lineCount: number;
  readonly byteSize: number;
  /** Whether the body spilled to a file rather than injecting inline. */
  readonly spilled: boolean;
  /** One line: kind · lines · size (· spilled). */
  readonly summary: string;
}

/**
 * Everything the picker's preview panel can render: an image thumbnail (Capture
 * or a relayed clipboard image) or a relayed text head. Discriminated by the
 * text variant's `kind: "text"` — the image variant carries no `kind`.
 */
export type PickerPreview = CapturePreview | ClipboardTextPreview;

/**
 * The image operations a thumbnail needs, mirroring Electron's `nativeImage`
 * so main.ts can pass the real thing and tests can pass a fake. Every method
 * here is one nativeImage already implements.
 */
export interface ThumbnailImagePort {
  getSize(): ThumbnailSize;
  resize(size: ThumbnailSize): ThumbnailImagePort;
  toDataURL(): string;
  isEmpty(): boolean;
}

/** Loads a PNG off disk. `nativeImage.createFromPath` in production. */
export type ThumbnailImageLoader = (pngPath: string) => ThumbnailImagePort;

/**
 * Contain-fit: scales `source` down to fit inside `box`, preserving aspect
 * ratio. Never upscales — a captured window smaller than the box keeps its
 * own size rather than rendering blurry-huge. Always at least 1x1 so a
 * degenerate size can't produce a zero-dimension resize.
 */
export function fitWithin(source: ThumbnailSize, box: ThumbnailSize): ThumbnailSize {
  if (source.width <= 0 || source.height <= 0) {
    return { width: 1, height: 1 };
  }

  const scale = Math.min(box.width / source.width, box.height / source.height, 1);

  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/**
 * Renders a capture's PNG into a preview for the picker. Best-effort by
 * contract: any failure returns null and the picker simply renders without a
 * preview — a thumbnail must never fail a capture, block the picker's first
 * frame, or change a delivery outcome.
 *
 * Note `nativeImage.createFromPath` returns an *empty* image rather than
 * throwing when the file is missing or undecodable, so `isEmpty()` is the
 * real check; the try/catch is belt-and-braces.
 */
export function renderCapturePreview(
  load: ThumbnailImageLoader,
  artifact: CaptureArtifact,
  box: ThumbnailSize = CAPTURE_PREVIEW_BOX,
): CapturePreview | null {
  try {
    const image = load(artifact.pngPath);
    if (image.isEmpty()) {
      return null;
    }

    const dataUrl = image.resize(fitWithin(image.getSize(), box)).toDataURL();
    if (!dataUrl) {
      return null;
    }

    return { dataUrl, windowTitle: artifact.windowTitle };
  } catch {
    return null;
  }
}
