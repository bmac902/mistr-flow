import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CAPTURE_TTL_MS, sweepExpiredCaptures } from "../src/capture";
import { captureArtifactToPayload } from "../src/deliver";
import {
  CLIPBOARD_IMAGE_LABEL,
  CLIPBOARD_PREVIEW_LINES,
  CLIPBOARD_SPILL_THRESHOLD,
  readClipboardSource,
  type ClipboardImagePort,
  type ClipboardSourcePort,
} from "../src/clipboardSource";

// Platform-native, not POSIX-hardcoded: production joins this with path.join,
// which yields backslashes on Windows. A literal "/tmp/..." passes in the
// Linux batch container and fails on the Windows host this app actually runs
// on — the assertion must be about the directory, not the separator.
const CAPTURE_DIR = path.join(path.sep, "tmp", "MistrFlowCaptures");

interface FakeClipboardOptions {
  text?: string;
  imagePng?: Buffer | null;
  filePath?: string | null;
  dropList?: string[] | null;
}

interface FakeClipboard {
  port: ClipboardSourcePort;
  writes: Map<string, Buffer | string>;
  mintCount: () => number;
}

function fakeClipboard(options: FakeClipboardOptions = {}): FakeClipboard {
  const writes = new Map<string, Buffer | string>();
  let minted = 0;
  const imagePng = options.imagePng;

  const image: ClipboardImagePort = {
    isEmpty: () => imagePng == null || imagePng.length === 0,
    toPNG: () => imagePng ?? Buffer.alloc(0),
  };

  const port: ClipboardSourcePort = {
    readText: () => options.text ?? "",
    readImage: () => image,
    readFilePath: () => options.filePath ?? null,
    readFileDropList: async () => options.dropList ?? null,
    writeFile: async (filePath, data) => {
      writes.set(filePath, data);
    },
    mintId: () => `relay-id-${++minted}`,
    timestampIso: () => "2026-07-16T09:00:00.000Z",
    captureDir: CAPTURE_DIR,
  };

  return { port, writes, mintCount: () => minted };
}

// ---------------------------------------------------------------------------
// Empty / unusable
// ---------------------------------------------------------------------------

test("an empty clipboard produces a typed nothing-to-send result, never a fake payload", async () => {
  const { port, writes } = fakeClipboard({ text: "", imagePng: null });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "empty");
  assert.equal(writes.size, 0, "nothing is written for an empty clipboard");
});

test("a whitespace-only clipboard is nothing-to-send, not an inline space payload", async () => {
  const { port } = fakeClipboard({ text: "   \n\t  \n ", imagePng: null });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "empty");
});

// ---------------------------------------------------------------------------
// Text — inline
// ---------------------------------------------------------------------------

test("short text produces an inline payload with no spill file", async () => {
  const { port, writes } = fakeClipboard({
    text: "TypeError: cannot read 'x' of undefined\n  at foo (bar.ts:12)",
  });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "text");
  if (source.kind !== "text") return;

  // The text itself is injected verbatim; no file, so no requiresFile precondition.
  assert.equal(
    source.payload.injectText,
    "TypeError: cannot read 'x' of undefined\n  at foo (bar.ts:12)",
  );
  assert.equal(source.payload.requiresFile, undefined);
  assert.equal(source.spillPath, undefined);
  assert.equal(writes.size, 0, "inline text spills nothing to disk");
  assert.equal(source.preview.spilled, false);
});

test("inline text preview carries the head lines and a kind · lines · size summary", async () => {
  const body = ["line 1", "line 2", "line 3"].join("\n");
  const { port } = fakeClipboard({ text: body });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "text");
  if (source.kind !== "text") return;

  assert.equal(source.preview.lineCount, 3);
  assert.equal(source.preview.byteSize, Buffer.byteLength(body, "utf8"));
  assert.equal(source.preview.truncated, false);
  assert.equal(source.preview.firstLines, body);
  assert.equal(source.preview.summary, `Text · 3 lines · ${body.length} B`);
});

test("a single-line preview summary says '1 line', not '1 lines'", async () => {
  const { port } = fakeClipboard({ text: "https://example.com/x" });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "text");
  if (source.kind !== "text") return;

  assert.match(source.preview.summary, /Text · 1 line · /);
});

test("the text preview shows only the head of a long body and flags it truncated", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const { port } = fakeClipboard({ text: lines.join("\n") });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "text");
  if (source.kind !== "text") return;

  assert.equal(source.preview.lineCount, 40);
  assert.equal(source.preview.truncated, true);
  assert.equal(
    source.preview.firstLines,
    lines.slice(0, CLIPBOARD_PREVIEW_LINES).join("\n"),
  );
});

// ---------------------------------------------------------------------------
// Text — spill threshold
// ---------------------------------------------------------------------------

test("text over the threshold spills the COMPLETE body to a temp file, nothing truncated", async () => {
  const body = "x".repeat(CLIPBOARD_SPILL_THRESHOLD + 500) + "\nTAIL-MATTERS";
  const { port, writes } = fakeClipboard({ text: body });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "text");
  if (source.kind !== "text") return;

  const spillPath = source.spillPath;
  assert.ok(spillPath, "a spill path is produced");
  // The injected string is the file path, not the body; the file exists first.
  assert.equal(source.payload.injectText, spillPath);
  assert.equal(source.payload.requiresFile, spillPath);
  assert.equal(source.preview.spilled, true);

  const written = writes.get(spillPath as string);
  assert.equal(written, body, "the spilled file holds the exact original text");
  assert.equal(
    (written as string).length,
    body.length,
    "nothing is truncated — the tail is intact",
  );
  assert.match(written as string, /TAIL-MATTERS$/);
});

test("the spill file lands in the capture temp dir with a relay prefix", async () => {
  const { port } = fakeClipboard({ text: "y".repeat(CLIPBOARD_SPILL_THRESHOLD + 1) });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "text");
  if (source.kind !== "text") return;

  assert.equal(path.dirname(source.spillPath as string), CAPTURE_DIR);
  assert.match(path.basename(source.spillPath as string), /^relay-.*\.txt$/);
});

test("threshold boundary: exactly the limit stays inline; one over spills", async () => {
  const atLimit = fakeClipboard({ text: "a".repeat(CLIPBOARD_SPILL_THRESHOLD) });
  const overLimit = fakeClipboard({
    text: "a".repeat(CLIPBOARD_SPILL_THRESHOLD + 1),
  });
  const underLimit = fakeClipboard({
    text: "a".repeat(CLIPBOARD_SPILL_THRESHOLD - 1),
  });

  const at = await readClipboardSource(atLimit.port);
  const over = await readClipboardSource(overLimit.port);
  const under = await readClipboardSource(underLimit.port);

  assert.equal(at.kind === "text" && at.spillPath, undefined);
  assert.equal(under.kind === "text" && under.spillPath, undefined);
  assert.equal(atLimit.writes.size, 0);
  assert.equal(underLimit.writes.size, 0);
  assert.ok(over.kind === "text" && over.spillPath, "one char over spills");
  assert.equal(overLimit.writes.size, 1);
});

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

test("an image clipboard produces a PNG-path payload equivalent to a screenshot's", async () => {
  const png = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
  const { port, writes } = fakeClipboard({ imagePng: png });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "image");
  if (source.kind !== "image") return;

  // The written PNG lands in the capture dir; the artifact points at it.
  assert.equal(path.dirname(source.artifact.pngPath), CAPTURE_DIR);
  assert.match(path.basename(source.artifact.pngPath), /^relay-.*\.png$/);
  assert.equal(writes.get(source.artifact.pngPath), png);

  // Same artifact shape as a screenshot: the payload is the PNG path as both
  // the injected text and the required file — identical to captureArtifactToPayload.
  assert.deepEqual(source.payload, captureArtifactToPayload(source.artifact));
  assert.equal(source.payload.injectText, source.artifact.pngPath);
  assert.equal(source.payload.requiresFile, source.artifact.pngPath);
});

test("the image artifact carries a clipboard label the existing preview can render", async () => {
  const { port } = fakeClipboard({ imagePng: Buffer.from([1, 2, 3]) });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "image");
  if (source.kind !== "image") return;

  assert.equal(source.artifact.windowTitle, CLIPBOARD_IMAGE_LABEL);
  assert.equal(source.artifact.processName, "clipboard");
  assert.equal(source.artifact.takenAt, "2026-07-16T09:00:00.000Z");
});

test("text wins over an image when the clipboard carries both", async () => {
  const { port } = fakeClipboard({
    text: "console.log('both')",
    imagePng: Buffer.from([137, 80, 78, 71]),
  });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "text");
});

// ---------------------------------------------------------------------------
// TTL sweep — spill/PNG files share the capture convention
// ---------------------------------------------------------------------------

test("relay spill and image files follow the capture TTL sweep", async () => {
  const now = 5_000_000;
  const files: Record<string, number> = {
    "relay-id-1.txt": now - CAPTURE_TTL_MS - 1, // expired spill
    "relay-id-2.png": now - CAPTURE_TTL_MS - 1, // expired relayed image
    "relay-id-3.txt": now - 1000, // fresh spill survives
  };
  const unlinked: string[] = [];

  const deleted = await sweepExpiredCaptures({
    captureDir: CAPTURE_DIR,
    now: () => now,
    readdir: async () => Object.keys(files),
    stat: async (filePath) => ({ mtimeMs: files[path.basename(filePath)] }),
    unlink: async (filePath) => {
      unlinked.push(path.basename(filePath));
    },
  });

  assert.deepEqual(new Set(unlinked), new Set(["relay-id-1.txt", "relay-id-2.png"]));
  assert.equal(deleted.length, 2, "the fresh spill is not swept");
});

// ---------------------------------------------------------------------------
// File (copied in Explorer) — found live 2026-07-15
// ---------------------------------------------------------------------------

// String.raw: a Windows path is all backslashes, and in a normal string
// literal "\U"/"\O"/"\D" silently drop their slash while "\b" becomes a
// backspace character — a corrupted path that still compiles.
const COPIED_FILE = String.raw`C:\Users\blair\OneDrive\Documents\generate_finops_json.py`;

test("a copied file becomes a path payload — the shape delivery already handles", async () => {
  // Verified live: a file copy sets NEITHER text nor a bitmap (readText() is
  // "" and readImage() is empty); the path arrives via readBuffer("FileNameW").
  const { port } = fakeClipboard({ text: "", imagePng: null, filePath: COPIED_FILE });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "file");
  if (source.kind !== "file") return;
  assert.equal(source.filePath, COPIED_FILE);
  // Identical shape to a PNG/spill payload: deliver verifies the file exists,
  // then injects the path plain so the agent's own path-detection fires.
  assert.equal(source.payload.injectText, COPIED_FILE);
  assert.equal(source.payload.requiresFile, COPIED_FILE);
});

test("a copied file writes nothing — it already exists on disk", async () => {
  const { port, writes } = fakeClipboard({ filePath: COPIED_FILE });

  await readClipboardSource(port);

  assert.equal(writes.size, 0, "no spill: the file is its own payload");
});

test("the file preview names the file rather than dumping its path blind", async () => {
  const { port } = fakeClipboard({ filePath: COPIED_FILE });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "file");
  if (source.kind !== "file") return;

  assert.match(source.preview.summary, /^file · generate_finops_json\.py$/);
  assert.equal(source.preview.firstLines, COPIED_FILE);
  assert.equal(source.preview.spilled, false, "a file is not a spill");
});

test("text still wins over a file when the clipboard carries both", async () => {
  const { port } = fakeClipboard({ text: "actual copied text", filePath: COPIED_FILE });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "text");
});

test("an image still wins over a file when the clipboard carries both", async () => {
  const { port } = fakeClipboard({
    imagePng: Buffer.from([137, 80, 78, 71]),
    filePath: COPIED_FILE,
  });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "image");
});

test("no text, no image and no file is still an empty clipboard", async () => {
  const { port } = fakeClipboard({ text: "", imagePng: null, filePath: null });

  assert.equal((await readClipboardSource(port)).kind, "empty");
});

test("a blank file path is treated as no file, never as a payload", async () => {
  const { port } = fakeClipboard({ filePath: "   " });

  assert.equal((await readClipboardSource(port)).kind, "empty");
});

// ---------------------------------------------------------------------------
// Files (Explorer multi-select) — classification (issue #67)
//
// The port's readFileDropList is a `Get-Clipboard -Format FileDropList`
// shell-out in production: Electron's clipboard API cannot read a Windows
// file drop (readBuffer("CF_HDROP") registers an always-empty custom format
// of that NAME; read("text/uri-list") returns "" — verified live 2026-07-16),
// so the full multi-select list arrives as paths, not as a raw struct.
// ---------------------------------------------------------------------------

const MULTI_SELECT = [
  String.raw`C:\Users\blair\OneDrive\Documents\generate_finops_json.py`,
  String.raw`C:\Users\blair\OneDrive\Documents\finops_report.xlsx`,
  String.raw`C:\Users\blair\OneDrive\Documents\notes.md`,
];

test("a multi-select classifies to a files source: every path, newline-joined, ONE payload", async () => {
  const { port, writes } = fakeClipboard({ dropList: MULTI_SELECT });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "files");
  if (source.kind !== "files") return;
  assert.deepEqual(source.filePaths, MULTI_SELECT);
  // One atomic block: N paths inject as a single newline-joined body — one
  // payload, one ledger entry, one ack, one retry (grilled decision 1).
  assert.equal(source.payload.injectText, MULTI_SELECT.join("\n"));
  // All-or-nothing guard: every path is a delivery precondition (decision 2).
  assert.deepEqual(source.payload.requiresFiles, MULTI_SELECT);
  assert.equal(source.payload.requiresFile, undefined);
  assert.equal(writes.size, 0, "no spill: the files are their own payload");
});

test("the files preview shows FULL paths one per line — the directory is the payload's identity", async () => {
  const { port } = fakeClipboard({ dropList: MULTI_SELECT });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "files");
  if (source.kind !== "files") return;

  assert.equal(source.preview.firstLines, MULTI_SELECT.join("\n"));
  assert.equal(source.preview.truncated, false);
  assert.equal(source.preview.lineCount, MULTI_SELECT.length);
  assert.equal(source.preview.spilled, false);
  assert.equal(source.preview.summary, `Files · ${MULTI_SELECT.length}`);
});

test("the files preview truncates past the existing line limit, exactly like text", async () => {
  const many = Array.from(
    { length: CLIPBOARD_PREVIEW_LINES + 2 },
    (_, i) => String.raw`C:\dev\mistr-flow\src\file-${i + 1}.ts`,
  );
  const { port } = fakeClipboard({ dropList: many });

  const source = await readClipboardSource(port);
  assert.equal(source.kind, "files");
  if (source.kind !== "files") return;

  assert.equal(
    source.preview.firstLines,
    many.slice(0, CLIPBOARD_PREVIEW_LINES).join("\n"),
  );
  assert.equal(source.preview.truncated, true);
  assert.equal(source.preview.summary, `Files · ${many.length}`);
});

test("a single-file drop list is byte-identical to today's FileNameW result", async () => {
  // N=1 must stay exactly today's single-file relay: same payload shape (no
  // requiresFiles key), same 'file · name.py' summary, same single-line
  // unbracketed injection — the receiving agent's auto-attach depends on it.
  const viaDropList = await readClipboardSource(
    fakeClipboard({ dropList: [COPIED_FILE] }).port,
  );
  const viaFileNameW = await readClipboardSource(
    fakeClipboard({ filePath: COPIED_FILE }).port,
  );

  assert.deepEqual(viaDropList, viaFileNameW);
  assert.equal(viaDropList.kind, "file");
});

test("a null drop list (shell-out failed or format absent) falls back to the FileNameW read", async () => {
  const { port } = fakeClipboard({ dropList: null, filePath: COPIED_FILE });

  const source = await readClipboardSource(port);

  assert.equal(source.kind, "file");
  if (source.kind !== "file") return;
  assert.equal(source.filePath, COPIED_FILE);
});

test("a drop list of blank entries is no file at all, never a payload", async () => {
  const { port } = fakeClipboard({ dropList: ["   ", " "] });

  assert.equal((await readClipboardSource(port)).kind, "empty");
});

test("text still wins over a multi-select; an image still wins too", async () => {
  const text = await readClipboardSource(
    fakeClipboard({ text: "copied text", dropList: MULTI_SELECT }).port,
  );
  assert.equal(text.kind, "text");

  const image = await readClipboardSource(
    fakeClipboard({
      imagePng: Buffer.from([137, 80, 78, 71]),
      dropList: MULTI_SELECT,
    }).port,
  );
  assert.equal(image.kind, "image");
});

test("an absurd list over the spill threshold rides the existing spill machinery — nothing truncated", async () => {
  // No enforced cap (grilled decision 4): designed-for-small-N is an
  // assumption, not a wall. A list whose joined body exceeds the threshold
  // spills whole to a temp file, exactly as long text does.
  const dir = String.raw`C:\Users\blair\Downloads\a-directory-name-long-enough-to-matter`;
  const absurd = Array.from(
    { length: 200 },
    (_, i) => `${dir}\\file-${String(i + 1).padStart(3, "0")}.log`,
  );
  const joined = absurd.join("\n");
  assert.ok(joined.length > CLIPBOARD_SPILL_THRESHOLD, "the fixture really exceeds the threshold");

  const { port, writes } = fakeClipboard({ dropList: absurd });
  const source = await readClipboardSource(port);

  assert.equal(source.kind, "files");
  if (source.kind !== "files") return;
  const spillPath = source.spillPath;
  assert.ok(spillPath, "the list spilled to a file");
  assert.equal(path.dirname(spillPath as string), CAPTURE_DIR);
  assert.equal(source.payload.injectText, spillPath, "the injected string is the spill path");
  assert.equal(source.payload.requiresFile, spillPath, "the spill file is a precondition");
  // The originals stay preconditions too — all-or-nothing survives the spill.
  assert.deepEqual(source.payload.requiresFiles, absurd);
  assert.equal(writes.get(spillPath as string), joined, "the whole list reached disk");
  assert.equal(source.preview.spilled, true);
  assert.equal(source.preview.summary, `Files · ${absurd.length} · spilled to file`);
});
