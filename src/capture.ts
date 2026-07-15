import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// Active-window capture (issue #26, PRD #24). MF shells out to the checked-in
// PowerShell/Win32 helper (scripts/capture-active-window.ps1) via the house
// `powershell -NoProfile` + execFile pattern (see systemAudio.ts, herdr.ts) —
// no new native-binary dependency, per the Defender/keylogger precedent
// (CONTEXT.md). The wrapper mints the CaptureArtifact's UUID and validates
// the resulting PNG; a bad grab is never returned as success.

/** Deadline for the capture helper subprocess. */
export const CAPTURE_TIMEOUT_MS = 5000;

/** Ordinary TTL for transient capture temp files — nothing is archived. */
export const CAPTURE_TTL_MS = 15 * 60 * 1000;

/**
 * What downstream consumers (deliver, Clipboard) receive. An id alone
 * locates no bytes — the artifact carries the temp PNG path itself, and no
 * hidden id→file map exists in the main process.
 */
export interface CaptureArtifact {
  readonly id: string;
  readonly pngPath: string;
  readonly windowTitle: string;
  readonly processName: string;
  readonly takenAt: string;
}

export type CaptureFailureCode =
  | "helper-not-found"
  | "helper-error"
  | "malformed-output"
  | "capture-timeout"
  | "empty-image"
  | "black-image";

const SAFE_MESSAGES: Record<CaptureFailureCode, string> = {
  "helper-not-found":
    "Couldn't find the capture helper — nothing snapped, sir.",
  "helper-error": "The capture helper stumbled — nothing snapped, sir.",
  "malformed-output": "The capture helper's answer didn't make sense.",
  "capture-timeout":
    "The capture helper took too long — nothing snapped, sir.",
  "empty-image": "That grab came back empty — no evidence worth keeping.",
  "black-image": "That grab came back solid black — no evidence worth keeping.",
};

/** The only text a consumer may render for a failure. Never raw error output. */
export function safeMessageFor(code: CaptureFailureCode): string {
  return SAFE_MESSAGES[code];
}

export type CaptureResult =
  | { readonly kind: "captured"; readonly artifact: CaptureArtifact }
  | {
      readonly kind: "capture-failed";
      readonly code: CaptureFailureCode;
      readonly message: string;
    };

type ExecCallbackError = (Error & { code?: string | number }) | null;

/** Minimal `execFile` shape — mirrors node's callback contract for mocking. */
export type CaptureExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (error: ExecCallbackError, stdout: string, stderr: string) => void,
) => void;

/** Injectable timer seam so the capture deadline can be driven by a fake clock. */
export interface CaptureClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CaptureAdapterDeps {
  readonly execFile?: CaptureExecFile;
  readonly clock?: CaptureClock;
  readonly timeoutMs?: number;
  readonly scriptPath?: string;
  readonly mintId?: () => string;
  readonly readFile?: (filePath: string) => Promise<Buffer>;
  /** MF's own overlay HWND, passed through so the helper refuses to grab it. */
  readonly excludeHwnd?: string;
}

const DEFAULT_SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "capture-active-window.ps1",
);

const defaultExecFile: CaptureExecFile = (file, args, callback) => {
  nodeExecFile(
    file,
    [...args],
    { maxBuffer: 10 * 1024 * 1024 },
    (error, stdout, stderr) => {
      callback(error as ExecCallbackError, stdout ?? "", stderr ?? "");
    },
  );
};

const defaultClock: CaptureClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const defaultReadFile = (filePath: string): Promise<Buffer> =>
  fsPromises.readFile(filePath);

/**
 * Invoke the capture helper and return exactly one typed result. Atomicity
 * of pixels+metadata is structural in the helper script (single foreground
 * read); this wrapper additionally validates the saved PNG independently
 * before ever minting a CaptureArtifact.
 */
export async function captureActiveWindow(
  deps: CaptureAdapterDeps = {},
): Promise<CaptureResult> {
  const execFile = deps.execFile ?? defaultExecFile;
  const clock = deps.clock ?? defaultClock;
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const scriptPath = deps.scriptPath ?? DEFAULT_SCRIPT_PATH;
  const mintId = deps.mintId ?? randomUUID;
  const readFile = deps.readFile ?? defaultReadFile;

  const args = [
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ];
  if (deps.excludeHwnd) {
    args.push("-ExcludeHwnd", deps.excludeHwnd);
  }

  const outcome = await runCaptureWithDeadline(execFile, args, clock, timeoutMs);

  if (outcome.kind === "timeout") {
    return failure("capture-timeout");
  }

  if (outcome.error) {
    if (typeof outcome.error.code === "string") {
      // Spawn failure (ENOENT/EACCES/…): powershell itself isn't runnable.
      return failure("helper-not-found");
    }
    // Non-zero exit: the helper ran but declined the grab.
    return failure("helper-error");
  }

  const metadata = parseCaptureMetadata(outcome.stdout);
  if (!metadata) {
    return failure("malformed-output");
  }

  let pngBuffer: Buffer;
  try {
    pngBuffer = await readFile(metadata.pngPath);
  } catch {
    return failure("empty-image");
  }

  const validation = validateCapturePng(pngBuffer);
  if (validation === "empty") {
    return failure("empty-image");
  }
  if (validation === "black") {
    return failure("black-image");
  }

  return {
    kind: "captured",
    artifact: {
      id: mintId(),
      pngPath: metadata.pngPath,
      windowTitle: metadata.windowTitle,
      processName: metadata.processName,
      takenAt: metadata.takenAt,
    },
  };
}

interface CaptureMetadata {
  readonly windowTitle: string;
  readonly processName: string;
  readonly pngPath: string;
  readonly takenAt: string;
}

/** Parse the helper's stdout JSON; null on anything unusable. */
export function parseCaptureMetadata(stdout: string): CaptureMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.windowTitle !== "string" ||
    typeof record.processName !== "string" ||
    typeof record.pngPath !== "string" ||
    record.pngPath.length === 0 ||
    typeof record.takenAt !== "string"
  ) {
    return null;
  }
  return {
    windowTitle: record.windowTitle,
    processName: record.processName,
    pngPath: record.pngPath,
    takenAt: record.takenAt,
  };
}

function failure(code: CaptureFailureCode): CaptureResult {
  return { kind: "capture-failed", code, message: safeMessageFor(code) };
}

type DeadlineOutcome =
  | { readonly kind: "timeout" }
  | {
      readonly kind: "exec";
      readonly error: ExecCallbackError;
      readonly stdout: string;
      readonly stderr: string;
    };

function runCaptureWithDeadline(
  execFile: CaptureExecFile,
  args: ReadonlyArray<string>,
  clock: CaptureClock,
  timeoutMs: number,
): Promise<DeadlineOutcome> {
  return new Promise((resolve) => {
    let settled = false;

    const handle = clock.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);

    execFile("powershell", args, (error, stdout, stderr) => {
      if (settled) {
        // A late response after the deadline is ignored — it can never
        // resurrect a capture whose deadline already passed.
        return;
      }
      settled = true;
      clock.clearTimeout(handle);
      resolve({ kind: "exec", error, stdout, stderr });
    });
  });
}

// --- PNG validation ----------------------------------------------------
//
// Decodes just enough of the PNG spec (8-bit, non-interlaced grayscale/RGB/
// RGBA) to answer "is this evidence at all?" using only node:zlib — no new
// npm dependency. A file that fails to parse carries no usable evidence,
// same as an empty one.

export type CapturePngValidation = "valid" | "empty" | "black";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validateCapturePng(buffer: Buffer): CapturePngValidation {
  if (buffer.length === 0) {
    return "empty";
  }

  let decoded: DecodedPng;
  try {
    decoded = decodePng(buffer);
  } catch {
    return "empty";
  }

  return isAllBlack(decoded) ? "black" : "valid";
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
  readonly pixels: Buffer;
}

function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || !PNG_SIGNATURE.equals(buffer.subarray(0, 8))) {
    throw new Error("not a PNG file");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataStart + length + 4; // skip the trailing CRC
  }

  if (width === 0 || height === 0) {
    throw new Error("missing IHDR");
  }
  if (bitDepth !== 8) {
    throw new Error(`unsupported bit depth: ${bitDepth}`);
  }
  if (interlace !== 0) {
    throw new Error("interlaced PNG not supported");
  }

  const bytesPerPixel = bytesPerPixelForColorType(colorType);
  const rowBytes = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(rowBytes * height);

  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * rowBytes;
    const prevRowStart = rowStart - rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0;
      const b = y > 0 ? pixels[prevRowStart + x] : 0;
      const c =
        y > 0 && x >= bytesPerPixel
          ? pixels[prevRowStart + x - bytesPerPixel]
          : 0;

      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + Math.floor((a + b) / 2);
          break;
        case 4:
          value = rawByte + paethPredictor(a, b, c);
          break;
        default:
          throw new Error(`unsupported filter type: ${filterType}`);
      }
      pixels[rowStart + x] = value & 0xff;
    }
    rawOffset += rowBytes;
  }

  return { width, height, bytesPerPixel, pixels };
}

function bytesPerPixelForColorType(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // RGB
    case 4:
      return 2; // grayscale + alpha
    case 6:
      return 4; // RGBA
    default:
      throw new Error(`unsupported color type: ${colorType}`);
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function isAllBlack(decoded: DecodedPng): boolean {
  const { pixels, bytesPerPixel, width, height } = decoded;
  const colorChannels = bytesPerPixel === 1 || bytesPerPixel === 2 ? 1 : 3;

  for (let i = 0; i < width * height; i++) {
    const pixelStart = i * bytesPerPixel;
    for (let c = 0; c < colorChannels; c++) {
      if (pixels[pixelStart + c] !== 0) {
        return false;
      }
    }
  }
  return true;
}

// --- TTL sweep -----------------------------------------------------------
//
// Captures are transient working files with ordinary TTL cleanup; nothing
// is archived (CONTEXT.md — there is no Save verb).

export function defaultCaptureDir(): string {
  return path.join(os.tmpdir(), "MistrFlowCaptures");
}

export interface CaptureSweepDeps {
  readonly captureDir?: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly readdir?: (dir: string) => Promise<string[]>;
  readonly stat?: (filePath: string) => Promise<{ mtimeMs: number }>;
  readonly unlink?: (filePath: string) => Promise<void>;
}

/** Deletes capture files older than the TTL; returns the paths it deleted. */
export async function sweepExpiredCaptures(
  deps: CaptureSweepDeps = {},
): Promise<string[]> {
  const captureDir = deps.captureDir ?? defaultCaptureDir();
  const ttlMs = deps.ttlMs ?? CAPTURE_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  const readdir = deps.readdir ?? ((dir) => fsPromises.readdir(dir));
  const stat = deps.stat ?? ((filePath) => fsPromises.stat(filePath));
  const unlink = deps.unlink ?? ((filePath) => fsPromises.unlink(filePath));

  const cutoff = now() - ttlMs;

  let entries: string[];
  try {
    entries = await readdir(captureDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const deleted: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(captureDir, entry);
    const stats = await stat(filePath);
    if (stats.mtimeMs <= cutoff) {
      await unlink(filePath);
      deleted.push(filePath);
    }
  }

  return deleted;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
