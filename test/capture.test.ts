import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CAPTURE_TTL_MS,
  type CaptureClock,
  type CaptureExecFile,
  captureActiveWindow,
  parseCaptureMetadata,
  safeMessageFor,
  sweepExpiredCaptures,
  validateCapturePng,
} from "../src/capture";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "capture");
const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "capture-active-window.ps1",
);

function fixturePng(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, name));
}

interface MockResponse {
  error?: (Error & { code?: string | number }) | null;
  stdout?: string;
  stderr?: string;
}

function makeExec(response: MockResponse | "hang"): CaptureExecFile {
  return (file, args, callback) => {
    assert.equal(file, "powershell");
    assert.ok(args.includes("-File"));
    if (response === "hang") {
      return; // never calls back — exercised by the timeout test
    }
    callback(
      response.error ?? null,
      response.stdout ?? "",
      response.stderr ?? "",
    );
  };
}

interface FakeClock {
  clock: CaptureClock;
  fire(): void;
  scheduledMs: number[];
}

function makeFakeClock(): FakeClock {
  const scheduled: Array<{ cb: () => void; ms: number; handle: number }> = [];
  const cleared = new Set<number>();
  let nextHandle = 1;
  return {
    clock: {
      setTimeout(cb, ms) {
        const handle = nextHandle++;
        scheduled.push({ cb, ms, handle });
        return handle;
      },
      clearTimeout(handle) {
        cleared.add(handle as number);
      },
    },
    fire() {
      for (const s of scheduled) {
        if (!cleared.has(s.handle)) {
          s.cb();
        }
      }
    },
    get scheduledMs() {
      return scheduled.map((s) => s.ms);
    },
  };
}

function validMetadataJson(overrides: Partial<Record<string, string>> = {}) {
  return JSON.stringify({
    windowTitle: "Untitled — Notepad",
    processName: "notepad",
    pngPath: path.join(FIXTURE_DIR, "valid.png"),
    takenAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  });
}

function alwaysReadFixture(name: string) {
  return async () => fixturePng(name);
}

// ---------------------------------------------------------------------------
// captureActiveWindow — execFile paths
// ---------------------------------------------------------------------------

test("a successful grab returns a captured artifact combining metadata and a minted id", async () => {
  const result = await captureActiveWindow({
    execFile: makeExec({ stdout: validMetadataJson() }),
    readFile: alwaysReadFixture("valid.png"),
    mintId: () => "capture-uuid-1",
  });

  assert.deepEqual(result, {
    kind: "captured",
    artifact: {
      id: "capture-uuid-1",
      pngPath: path.join(FIXTURE_DIR, "valid.png"),
      windowTitle: "Untitled — Notepad",
      processName: "notepad",
      takenAt: "2026-07-15T10:00:00.000Z",
    },
  });
});

test("helper binary missing (ENOENT) maps to helper-not-found", async () => {
  const enoent = Object.assign(new Error("spawn powershell ENOENT"), {
    code: "ENOENT",
  });
  const result = await captureActiveWindow({
    execFile: makeExec({ error: enoent }),
    readFile: alwaysReadFixture("valid.png"),
  });

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "helper-not-found",
  );
  assert.equal(
    result.kind === "capture-failed" ? result.message : null,
    safeMessageFor("helper-not-found"),
  );
});

test("a non-zero helper exit maps to helper-error", async () => {
  const exitError = Object.assign(new Error("Command failed"), {});
  const result = await captureActiveWindow({
    execFile: makeExec({ error: exitError, stderr: "own-overlay" }),
    readFile: alwaysReadFixture("valid.png"),
  });

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "helper-error",
  );
});

test("unparseable stdout maps to malformed-output", async () => {
  const result = await captureActiveWindow({
    execFile: makeExec({ stdout: "not json at all" }),
    readFile: alwaysReadFixture("valid.png"),
  });

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "malformed-output",
  );
});

test("stdout missing required fields maps to malformed-output", async () => {
  const result = await captureActiveWindow({
    execFile: makeExec({ stdout: JSON.stringify({ windowTitle: "only this" }) }),
    readFile: alwaysReadFixture("valid.png"),
  });

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "malformed-output",
  );
});

test("a hung helper past the deadline maps to capture-timeout", async () => {
  const fakeClock = makeFakeClock();
  const promise = captureActiveWindow({
    execFile: makeExec("hang"),
    clock: fakeClock.clock,
    timeoutMs: 5000,
    readFile: alwaysReadFixture("valid.png"),
  });

  fakeClock.fire();
  const result = await promise;

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "capture-timeout",
  );
  assert.deepEqual(fakeClock.scheduledMs, [5000]);
});

test("a late response after the deadline is ignored", async () => {
  const fakeClock = makeFakeClock();
  let laterCallback:
    | ((error: null, stdout: string, stderr: string) => void)
    | null = null;
  const execFile: CaptureExecFile = (file, args, callback) => {
    laterCallback = callback;
  };

  const promise = captureActiveWindow({
    execFile,
    clock: fakeClock.clock,
    readFile: alwaysReadFixture("valid.png"),
  });

  fakeClock.fire();
  const result = await promise;
  assert.equal(result.kind, "capture-failed");

  // Simulate the subprocess finally answering after the timeout already
  // resolved — must not throw or resurrect the settled promise.
  assert.doesNotThrow(() => {
    laterCallback?.(null, validMetadataJson(), "");
  });
});

// ---------------------------------------------------------------------------
// captureActiveWindow — PNG validation wired end-to-end
// ---------------------------------------------------------------------------

test("an empty PNG file maps to empty-image", async () => {
  const result = await captureActiveWindow({
    execFile: makeExec({ stdout: validMetadataJson() }),
    readFile: alwaysReadFixture("empty.png"),
  });

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "empty-image",
  );
});

test("an all-black PNG file maps to black-image", async () => {
  const result = await captureActiveWindow({
    execFile: makeExec({ stdout: validMetadataJson() }),
    readFile: alwaysReadFixture("black.png"),
  });

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "black-image",
  );
});

test("a missing PNG file on disk maps to empty-image, never a thrown error", async () => {
  const result = await captureActiveWindow({
    execFile: makeExec({ stdout: validMetadataJson() }),
    readFile: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });

  assert.equal(result.kind, "capture-failed");
  assert.equal(
    result.kind === "capture-failed" ? result.code : null,
    "empty-image",
  );
});

// ---------------------------------------------------------------------------
// PNG validation — pure fixture tests
// ---------------------------------------------------------------------------

test("validateCapturePng: a real image is valid", () => {
  assert.equal(validateCapturePng(fixturePng("valid.png")), "valid");
});

test("validateCapturePng: a zero-byte file is empty", () => {
  assert.equal(validateCapturePng(fixturePng("empty.png")), "empty");
});

test("validateCapturePng: a solid-black image is black", () => {
  assert.equal(validateCapturePng(fixturePng("black.png")), "black");
});

test("validateCapturePng: corrupt bytes are treated as empty, not thrown", () => {
  assert.equal(validateCapturePng(Buffer.from("not a png")), "empty");
});

// ---------------------------------------------------------------------------
// parseCaptureMetadata
// ---------------------------------------------------------------------------

test("parseCaptureMetadata rejects a JSON value that isn't an object", () => {
  assert.equal(parseCaptureMetadata("42"), null);
  assert.equal(parseCaptureMetadata("null"), null);
  assert.equal(parseCaptureMetadata("[]"), null);
});

test("parseCaptureMetadata rejects an empty pngPath", () => {
  assert.equal(parseCaptureMetadata(validMetadataJson({ pngPath: "" })), null);
});

// ---------------------------------------------------------------------------
// Atomicity — structural contract on the checked-in helper script
// ---------------------------------------------------------------------------

test("the helper script reads the foreground window exactly once and reuses it", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  const foregroundReads = script.match(/::GetForegroundWindow\(\)/g) ?? [];
  assert.equal(
    foregroundReads.length,
    1,
    "GetForegroundWindow must be called exactly once — atomicity is structural",
  );

  assert.match(script, /\$hwnd\s*=\s*\[MistrFlowCapture\.Native\]::GetForegroundWindow\(\)/);

  // Every downstream metadata/pixel read binds to the same $hwnd captured
  // above — never a second foreground-window lookup.
  for (const call of [
    "GetWindowTextLength($hwnd)",
    "GetWindowText($hwnd,",
    "GetWindowThreadProcessId($hwnd,",
    "GetWindowRect($hwnd,",
    "PrintWindow($hwnd,",
  ]) {
    assert.ok(
      script.includes(call),
      `expected script to reuse $hwnd for: ${call}`,
    );
  }
});

test("the helper script declares per-monitor DPI awareness before reading window metrics", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const dpiCallIndex = script.indexOf("SetProcessDpiAwarenessContext([IntPtr]::new(-4))");
  const hwndReadIndex = script.indexOf(
    "$hwnd = [MistrFlowCapture.Native]::GetForegroundWindow()",
  );

  assert.ok(dpiCallIndex >= 0, "expected a DPI awareness call");
  assert.ok(hwndReadIndex >= 0, "expected the foreground-window read");
  assert.ok(
    dpiCallIndex < hwndReadIndex,
    "DPI awareness must be declared before any window read",
  );
});

test("the screen-rect fallback is gated on visibility and never runs unconditionally", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(script, /CopyFromScreen/);
  assert.match(script, /IsWindowVisible/);
  assert.match(script, /IsIconic/);
});

test("wrapper contract: pixels and metadata arrive bound together in one stdout blob", async () => {
  const result = await captureActiveWindow({
    execFile: makeExec({
      stdout: validMetadataJson({
        windowTitle: "Combined Read",
        processName: "combined-proc",
      }),
    }),
    readFile: alwaysReadFixture("valid.png"),
    mintId: () => "combined-id",
  });

  assert.equal(result.kind, "captured");
  if (result.kind === "captured") {
    // Title/process metadata and the pixel file both trace back to the same
    // single helper invocation's stdout — the wrapper never mixes results
    // from two separate calls.
    assert.equal(result.artifact.windowTitle, "Combined Read");
    assert.equal(result.artifact.processName, "combined-proc");
    assert.equal(result.artifact.pngPath, path.join(FIXTURE_DIR, "valid.png"));
  }
});

// ---------------------------------------------------------------------------
// TTL sweep
// ---------------------------------------------------------------------------

function makeFsSeams(files: Record<string, number>) {
  const unlinked: string[] = [];
  return {
    unlinked,
    readdir: async (dir: string) => {
      assert.equal(dir, "/tmp/captures");
      return Object.keys(files);
    },
    stat: async (filePath: string) => {
      const name = path.basename(filePath);
      return { mtimeMs: files[name] };
    },
    unlink: async (filePath: string) => {
      unlinked.push(path.basename(filePath));
      delete files[path.basename(filePath)];
    },
  };
}

test("files older than the TTL are deleted; newer files survive", async () => {
  const now = 1_000_000;
  const seams = makeFsSeams({
    "old.png": now - CAPTURE_TTL_MS - 1,
    "borderline.png": now - CAPTURE_TTL_MS,
    "fresh.png": now - 1000,
  });

  const deleted = await sweepExpiredCaptures({
    captureDir: "/tmp/captures",
    now: () => now,
    readdir: seams.readdir,
    stat: seams.stat,
    unlink: seams.unlink,
  });

  assert.deepEqual(new Set(deleted.map((p) => path.basename(p))), new Set([
    "old.png",
    "borderline.png",
  ]));
  assert.deepEqual(new Set(seams.unlinked), new Set(["old.png", "borderline.png"]));
});

test("a missing capture directory sweeps to no-op instead of throwing", async () => {
  const deleted = await sweepExpiredCaptures({
    captureDir: "/tmp/does-not-exist",
    now: () => 0,
    readdir: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    stat: async () => {
      throw new Error("should not be called");
    },
    unlink: async () => {
      throw new Error("should not be called");
    },
  });

  assert.deepEqual(deleted, []);
});

test("a non-ENOENT readdir failure propagates instead of being swallowed", async () => {
  await assert.rejects(
    sweepExpiredCaptures({
      captureDir: "/tmp/captures",
      readdir: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      stat: async () => {
        throw new Error("should not be called");
      },
      unlink: async () => {
        throw new Error("should not be called");
      },
    }),
  );
});

test("an expired but retained file is neither unlinked nor returned", async () => {
  const now = 1_000_000;
  const seams = makeFsSeams({
    "retained.png": now - CAPTURE_TTL_MS - 1,
    "sweepable.png": now - CAPTURE_TTL_MS - 1,
  });

  const deleted = await sweepExpiredCaptures({
    captureDir: "/tmp/captures",
    now: () => now,
    readdir: seams.readdir,
    stat: seams.stat,
    unlink: seams.unlink,
    isRetained: (filePath) => path.basename(filePath) === "retained.png",
  });

  assert.deepEqual(deleted.map((p) => path.basename(p)), ["sweepable.png"]);
  assert.deepEqual(seams.unlinked, ["sweepable.png"]);
});

test("a fresh file is never swept, retained or not", async () => {
  const now = 1_000_000;
  const seams = makeFsSeams({ "fresh.png": now - 1000 });

  const deleted = await sweepExpiredCaptures({
    captureDir: "/tmp/captures",
    now: () => now,
    readdir: seams.readdir,
    stat: seams.stat,
    unlink: seams.unlink,
    isRetained: () => false,
  });

  assert.deepEqual(deleted, []);
  assert.deepEqual(seams.unlinked, []);
});

test("a stat ENOENT on one entry skips it and keeps sweeping the rest", async () => {
  const now = 1_000_000;
  const files: Record<string, number> = {
    "gone.png": now - CAPTURE_TTL_MS - 1,
    "old.png": now - CAPTURE_TTL_MS - 1,
  };
  const unlinked: string[] = [];

  const deleted = await sweepExpiredCaptures({
    captureDir: "/tmp/captures",
    now: () => now,
    readdir: async () => Object.keys(files),
    stat: async (filePath: string) => {
      const name = path.basename(filePath);
      if (name === "gone.png") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return { mtimeMs: files[name] };
    },
    unlink: async (filePath: string) => {
      unlinked.push(path.basename(filePath));
    },
  });

  assert.deepEqual(deleted.map((p) => path.basename(p)), ["old.png"]);
  assert.deepEqual(unlinked, ["old.png"]);
});

test("an unlink ENOENT on one entry skips it and keeps sweeping the rest", async () => {
  const now = 1_000_000;
  const files: Record<string, number> = {
    "racy.png": now - CAPTURE_TTL_MS - 1,
    "old.png": now - CAPTURE_TTL_MS - 1,
  };
  const unlinked: string[] = [];

  const deleted = await sweepExpiredCaptures({
    captureDir: "/tmp/captures",
    now: () => now,
    readdir: async () => Object.keys(files),
    stat: async (filePath: string) => ({ mtimeMs: files[path.basename(filePath)] }),
    unlink: async (filePath: string) => {
      const name = path.basename(filePath);
      if (name === "racy.png") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      unlinked.push(name);
    },
  });

  assert.deepEqual(deleted.map((p) => path.basename(p)), ["old.png"]);
  assert.deepEqual(unlinked, ["old.png"]);
});

test("a non-ENOENT stat failure propagates instead of being swallowed", async () => {
  const now = 1_000_000;
  await assert.rejects(
    sweepExpiredCaptures({
      captureDir: "/tmp/captures",
      now: () => now,
      readdir: async () => ["boom.png"],
      stat: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      unlink: async () => {
        throw new Error("should not be called");
      },
    }),
  );
});
