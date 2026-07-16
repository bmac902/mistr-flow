import path from "node:path";

import type { CaptureArtifact } from "./capture";
import type { ClipboardTextPreview } from "./captureThumbnail";
import { captureArtifactToPayload, type SendPayload } from "./deliver";

export type { ClipboardTextPreview } from "./captureThumbnail";

// Relay verb — the clipboard as a source (issue #38, PRD #24). MF's third sense
// organ, after voice (dictate) and screen (capture): read whatever is on the
// Windows clipboard once, classify it, and turn it into a {@link SendPayload}
// the send pipeline can route — killing the Ctrl+C → Alt+Tab → find pane →
// Ctrl+V dance for copied code, stack traces, URLs, and terminal output.
//
// House pattern: this is a PURE module — the classify/spill logic over an
// injected {@link ClipboardSourcePort}; the Electron `clipboard`/`nativeImage`
// and `fs` I/O live in the main process (main.ts). It imports no Electron, so
// tests drive it with a fake port.
//
// Read on demand only: this reads the clipboard once when called. It never
// watches, polls, or logs it, and keeps no history (CONTEXT.md — Relay).

/**
 * The inline/spill threshold, in characters (≈200 lines). Text under it injects
 * INLINE; text over it SPILLS to a temp file whose path is injected instead.
 *
 * Set deliberately high because inline is *strictly better UX*: text in the
 * pane's input box can be seen, edited, and wrapped in context before you send
 * it, whereas an injected path is an opaque black box the agent must `Read`.
 * Typical stack traces, copied functions, URLs, and terminal output all stay
 * inline; spilling is the fallback for whole files, giant logs, and huge diffs.
 * Do NOT lower it "to be safe" — that trades the common case away for the rare
 * one. Nothing is ever truncated either way: the tail of a stack trace is
 * usually the part that matters (CONTEXT.md, 2026-07-15).
 */
export const CLIPBOARD_SPILL_THRESHOLD = 10_000;

/** How many leading lines the text preview carries for the picker. */
export const CLIPBOARD_PREVIEW_LINES = 6;

/**
 * A clipboard image, mirroring the slice of Electron's `NativeImage` this
 * module needs. `clipboard.readImage()` returns an *empty* image (not null,
 * never throws) when there's no image — so `isEmpty()` is the real "nothing
 * here" check.
 */
export interface ClipboardImagePort {
  isEmpty(): boolean;
  toPNG(): Buffer;
}

/**
 * The clipboard read + file write + id/clock effects, mirroring what Electron
 * and node already give the main process. A fake in tests; the real
 * `clipboard`/`nativeImage`/`fs` in main.ts.
 *
 * `writeFile` must ensure the parent directory exists (spill/PNG files live in
 * the same {@link captureDir} as captures and share their TTL sweep).
 */
export interface ClipboardSourcePort {
  /** `clipboard.readText()` — returns `""` (not null) when there's no text. */
  readText(): string;
  /** `clipboard.readImage()` — returns an empty image when there's none. */
  readImage(): ClipboardImagePort;
  /**
   * The absolute path of a file copied in Explorer, or null when the clipboard
   * holds no file. Copying a file sets NEITHER text nor a bitmap — Windows puts
   * a file-drop list on the clipboard instead, so `readText()` is `""` and
   * `readImage()` is empty, and without this a copied file reads as "nothing to
   * relay" (confirmed live 2026-07-15). Electron surfaces the path via
   * `clipboard.readBuffer("FileNameW")` as UTF-16LE.
   *
   * Single file only: `FileNameW` carries just the first of a multi-select —
   * by design. It stays as the fallback when {@link readFileDropBuffer}'s
   * `CF_HDROP` is absent or unparseable (issue #67).
   */
  readFilePath(): string | null;
  /**
   * The clipboard's raw `CF_HDROP` buffer — the Windows DROPFILES struct that
   * carries EVERY file of an Explorer multi-select — or null when the
   * clipboard holds no file drop. `clipboard.readBuffer("CF_HDROP")` in
   * production; {@link parseFileDropList} does the pure parse here, so main.ts
   * supplies only the raw read (issue #67).
   */
  readFileDropBuffer(): Buffer | null;
  writeFile(filePath: string, data: Buffer | string): Promise<void>;
  /** Mints the payload/artifact id. `randomUUID` in production. */
  mintId(): string;
  /** ISO timestamp for the image artifact. `new Date().toISOString()` in prod. */
  timestampIso(): string;
  /** Where spill/PNG files are written — the capture temp dir, so the sweep reclaims them. */
  captureDir: string;
}

/** Preview data for a relayed image — the label the existing thumbnail treatment renders. */
export const CLIPBOARD_IMAGE_LABEL = "Clipboard image";

/**
 * Byte size of the DROPFILES header (shlobj_core.h): `pFiles` (DWORD, offset
 * 0 — where the path list starts), `pt` (POINT, 8 bytes), `fNC` (BOOL), and
 * `fWide` (BOOL, offset 16 — 1 means the list is UTF-16LE).
 */
const DROPFILES_HEADER_BYTES = 20;
const DROPFILES_FWIDE_OFFSET = 16;

/**
 * Parses the clipboard's raw `CF_HDROP` buffer — a Windows DROPFILES struct —
 * into the full path list of an Explorer multi-select (issue #67). `FileNameW`
 * carries only the FIRST file of a multi-select by design; this is the format
 * that carries them all.
 *
 * The list is NUL-terminated paths starting at the header's `pFiles` offset,
 * ending in a double NUL. Returns null for anything unparseable — a short or
 * malformed buffer, an out-of-range offset, an empty list, or an ANSI list
 * (`fWide` = 0, vanishingly rare from Explorer) — so the caller falls back to
 * the proven single-file `FileNameW` read rather than guessing.
 */
export function parseFileDropList(buffer: Buffer): string[] | null {
  if (buffer.length < DROPFILES_HEADER_BYTES) return null;

  const pFiles = buffer.readUInt32LE(0);
  if (pFiles < DROPFILES_HEADER_BYTES || pFiles >= buffer.length) return null;

  if (buffer.readUInt32LE(DROPFILES_FWIDE_OFFSET) === 0) return null;

  const paths: string[] = [];
  for (const entry of buffer.toString("utf16le", pFiles).split("\0")) {
    if (entry.length === 0) break; // the double-NUL terminator
    paths.push(entry);
  }
  return paths.length > 0 ? paths : null;
}

/**
 * The typed outcome of reading the clipboard. Distinct cases so the caller (the
 * Relay picker, #39) can render a truthful state — a text preview, an image
 * preview, or an explicit "nothing to send" — rather than a fake or empty
 * payload.
 */
export type ClipboardSource =
  | {
      readonly kind: "text";
      readonly payload: SendPayload;
      readonly preview: ClipboardTextPreview;
      /** The spill file written, when the body spilled; absent for inline text. */
      readonly spillPath?: string;
    }
  | {
      readonly kind: "image";
      readonly payload: SendPayload;
      /**
       * A {@link CaptureArtifact}-shaped grab: a clipboard image uses the exact
       * same PNG-path artifact a screenshot does, so the existing thumbnail,
       * crop, and delivery machinery applies with no new concepts (CONTEXT.md).
       */
      readonly artifact: CaptureArtifact;
    }
  | {
      /**
       * A file copied in Explorer. Its absolute path is the injected string —
       * the same shape a spilled body or a PNG already uses, so the whole
       * delivery path applies unchanged: `deliver` verifies the file exists,
       * and leaves the single-line body unbracketed so the receiving agent's
       * own path-detection still fires. A copied `.py` gets `Read`; a copied
       * `.png` gets seen.
       */
      readonly kind: "file";
      readonly payload: SendPayload;
      readonly preview: ClipboardTextPreview;
      readonly filePath: string;
    }
  | {
      /**
       * N≥2 files of an Explorer multi-select, read from `CF_HDROP` (issue
       * #67). One atomic block: the paths inject as a single newline-joined
       * body — one payload, one ledger entry, one ack, one retry — and every
       * path is a delivery precondition (`requiresFiles`), so a file that
       * vanished since the copy fails the WHOLE delivery, never a partial.
       * N=1 never lands here — it stays the byte-identical `file` case above,
       * bare and unbracketed, so path-detection/auto-attach is untouched.
       */
      readonly kind: "files";
      readonly payload: SendPayload;
      readonly preview: ClipboardTextPreview;
      readonly filePaths: readonly string[];
      /**
       * Present when the joined list exceeded {@link CLIPBOARD_SPILL_THRESHOLD}
       * — an absurd multi-select rides the existing spill machinery, whole
       * (no enforced cap, nothing truncated, nothing refused).
       */
      readonly spillPath?: string;
    }
  | { readonly kind: "empty" };

/**
 * Reads the clipboard once and classifies it into a routable {@link
 * ClipboardSource}. Text wins over an image when both are present: the flagship
 * image path (Win+Shift+S → hotkey) sets no text, so a pure image copy has an
 * empty `readText()` and still routes to the image branch — text-first only
 * ever affects a rich copy that carries both, where the copied text is exactly
 * what Relay-text is for.
 */
export async function readClipboardSource(
  port: ClipboardSourcePort,
): Promise<ClipboardSource> {
  const text = port.readText();
  if (text.trim().length > 0) {
    return classifyText(port, text);
  }

  const image = port.readImage();
  if (!image.isEmpty()) {
    return classifyImage(port, image);
  }

  // Last, because a file copy is the only case that sets neither text nor a
  // bitmap — so it can't collide with the branches above. CF_HDROP first: it
  // carries EVERY file of a multi-select, where FileNameW carries only the
  // first (issue #67). FileNameW stays as the fallback for an absent or
  // unparseable drop list, so a plain single-file copy can never regress.
  const dropBuffer = port.readFileDropBuffer();
  const dropPaths = dropBuffer ? parseFileDropList(dropBuffer) : null;
  const filePaths = (dropPaths ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (filePaths.length > 0) {
    return classifyFiles(port, filePaths);
  }

  const filePath = port.readFilePath();
  if (filePath && filePath.trim().length > 0) {
    return classifyFile(port, filePath.trim());
  }

  return { kind: "empty" };
}

/**
 * N files of an Explorer multi-select. N=1 delegates to {@link classifyFile}
 * — byte-identical to a FileNameW read, so auto-attach on the receiving agent
 * is untouched. N≥2 mirrors BOTH existing branches at once: the paths join
 * with newlines into one atomic injectText like text (bracketed-paste makes
 * the delivery atomic), and every path is a delivery precondition like a file.
 * A joined list over the spill threshold rides the text spill machinery whole
 * — no enforced cap, nothing truncated (grilled decisions, CONTEXT.md
 * 2026-07-16).
 */
async function classifyFiles(
  port: ClipboardSourcePort,
  filePaths: readonly string[],
): Promise<ClipboardSource> {
  if (filePaths.length === 1) {
    return classifyFile(port, filePaths[0]);
  }

  const id = port.mintId();
  const joined = filePaths.join("\n");
  const spilled = joined.length > CLIPBOARD_SPILL_THRESHOLD;

  // Full paths, one per line: the directory is the payload's identity —
  // basenames would hide exactly the wrong-file mistake the preview exists
  // to catch (grilled decision 3).
  const preview: ClipboardTextPreview = {
    kind: "text",
    firstLines: filePaths.slice(0, CLIPBOARD_PREVIEW_LINES).join("\n"),
    truncated: filePaths.length > CLIPBOARD_PREVIEW_LINES,
    lineCount: filePaths.length,
    byteSize: Buffer.byteLength(joined, "utf8"),
    spilled,
    summary: spilled
      ? `Files · ${filePaths.length} · spilled to file`
      : `Files · ${filePaths.length}`,
  };

  if (!spilled) {
    return {
      kind: "files",
      payload: { id, injectText: joined, requiresFiles: filePaths },
      preview,
      filePaths,
    };
  }

  // The absurd-list case: the WHOLE list spills to a temp file and its path is
  // injected, exactly as long text does. The originals stay preconditions —
  // the all-or-nothing guard survives the spill.
  const spillPath = path.join(port.captureDir, `relay-${id}.txt`);
  await port.writeFile(spillPath, joined);
  return {
    kind: "files",
    payload: {
      id,
      injectText: spillPath,
      requiresFile: spillPath,
      requiresFiles: filePaths,
    },
    preview,
    filePaths,
    spillPath,
  };
}

function classifyFile(port: ClipboardSourcePort, filePath: string): ClipboardSource {
  // No spill, no write: the file already exists on disk, so its own path is the
  // payload. `deliver`'s requiresFile precondition covers the case where it's
  // moved or deleted between copy and relay.
  const preview: ClipboardTextPreview = {
    kind: "text",
    firstLines: filePath,
    truncated: false,
    lineCount: 1,
    byteSize: Buffer.byteLength(filePath, "utf8"),
    spilled: false,
    // path.win32.basename, not path.basename: a clipboard file path always comes
    // from Windows' FileNameW, so backslashes are the separator regardless of the
    // host Node thinks it's running on. Plain path.basename returns the whole
    // string on POSIX (no `\` separator), which is right on Windows but wrong in
    // the Linux batch sandbox — the mirror of the /tmp spill-path test bug.
    summary: `file · ${path.win32.basename(filePath)}`,
  };

  return {
    kind: "file",
    payload: { id: port.mintId(), injectText: filePath, requiresFile: filePath },
    preview,
    filePath,
  };
}

async function classifyText(
  port: ClipboardSourcePort,
  text: string,
): Promise<ClipboardSource> {
  const id = port.mintId();
  const byteSize = Buffer.byteLength(text, "utf8");
  const lineCount = text.split("\n").length;
  const lines = text.split("\n");
  const firstLines = lines.slice(0, CLIPBOARD_PREVIEW_LINES).join("\n");
  const truncated = lines.length > CLIPBOARD_PREVIEW_LINES;

  const spilled = text.length > CLIPBOARD_SPILL_THRESHOLD;

  const summary = buildTextSummary("Text", lineCount, byteSize, spilled);
  const preview: ClipboardTextPreview = {
    kind: "text",
    firstLines,
    truncated,
    lineCount,
    byteSize,
    spilled,
    summary,
  };

  if (!spilled) {
    // Inline: the text itself is the injected string. No file, so the payload
    // declares no `requiresFile` precondition.
    return {
      kind: "text",
      payload: { id, injectText: text },
      preview,
    };
  }

  // Spill: write the COMPLETE text to a temp file and inject its absolute path.
  // Nothing is truncated — the whole body reaches disk for the agent to `Read`.
  const spillPath = path.join(port.captureDir, `relay-${id}.txt`);
  await port.writeFile(spillPath, text);
  return {
    kind: "text",
    payload: { id, injectText: spillPath, requiresFile: spillPath },
    preview,
    spillPath,
  };
}

async function classifyImage(
  port: ClipboardSourcePort,
  image: ClipboardImagePort,
): Promise<ClipboardSource> {
  const id = port.mintId();
  const pngPath = path.join(port.captureDir, `relay-${id}.png`);
  await port.writeFile(pngPath, image.toPNG());

  // A clipboard image is the same artifact shape a screenshot produces, so the
  // existing thumbnail/crop/delivery machinery routes it with no new concepts.
  // There is no source window, so the "title" is a plain label and the process
  // is `clipboard`.
  const artifact: CaptureArtifact = {
    id,
    pngPath,
    windowTitle: CLIPBOARD_IMAGE_LABEL,
    processName: "clipboard",
    takenAt: port.timestampIso(),
  };

  return {
    kind: "image",
    payload: captureArtifactToPayload(artifact),
    artifact,
  };
}

/**
 * The one-line `kind · lines · size` summary the picker's text preview shows.
 * Exported for Herald (issue #55), whose preview is the same panel with a
 * different kind label ("Polished" / a raw-fallback marker) — one formatter,
 * so every text preview reads the same.
 */
export function buildTextSummary(
  kindLabel: string,
  lineCount: number,
  byteSize: number,
  spilled: boolean,
): string {
  const lineLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  const base = `${kindLabel} · ${lineLabel} · ${humanBytes(byteSize)}`;
  return spilled ? `${base} · spilled to file` : base;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${roundTo(kb, 1)} KB`;
  }
  return `${roundTo(kb / 1024, 1)} MB`;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
