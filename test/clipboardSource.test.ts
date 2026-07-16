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

const CAPTURE_DIR = "/tmp/MistrFlowCaptures";

interface FakeClipboardOptions {
  text?: string;
  imagePng?: Buffer | null;
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
