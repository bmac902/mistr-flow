import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  buildCancelledOverlaySnapshot,
  buildOverlaySnapshot,
  buildErrorOverlaySnapshot,
  runHappyPathOverlaySession,
} from "../src/overlay";

const rootDir = path.join(__dirname, "..");

const expectedStatusCopy = {
  idle: "Ready when you are, sir.",
  listening: "Listening…",
  recording: "Go on, I’m taking notes…",
  processing: "Tidying your ramble…",
  polishing: "Ahem. Much better…",
  done: "Pasted, sir.",
  error: "Mistr Flo tripped over the microphone.",
  cancelled: "Very well. We shall pretend that never happened.",
} as const;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test("buildOverlaySnapshot distinguishes idle from active happy-path states", () => {
  const idle = buildOverlaySnapshot("idle");
  const listening = buildOverlaySnapshot("listening");
  const recording = buildOverlaySnapshot("recording");
  const processing = buildOverlaySnapshot("processing");
  const polishing = buildOverlaySnapshot("polishing");
  const cancelled = buildCancelledOverlaySnapshot();
  const done = buildOverlaySnapshot("done");
  const error = buildErrorOverlaySnapshot();
  const erroredWithToast = buildErrorOverlaySnapshot("Transcription failed.");

  assert.equal(idle.barMode, "peek");
  assert.equal(idle.waveformVisible, false);
  assert.equal(idle.mascotCopy, "hat + eyes");

  assert.equal(listening.barMode, "expanded");
  assert.equal(listening.waveformVisible, true);
  assert.equal(listening.mascotCopy, "tips top hat");

  assert.equal(recording.waveformVisible, true);
  assert.equal(recording.mascotCopy, "moustache wiggle");

  assert.equal(processing.waveformVisible, false);
  assert.equal(processing.mascotCopy, "cane twirl");

  assert.equal(polishing.waveformVisible, false);
  assert.equal(polishing.mascotCopy, "brushes sentence ribbon");

  assert.equal(cancelled.barMode, "expanded");
  assert.equal(cancelled.waveformVisible, false);
  assert.equal(cancelled.mascotCopy, "exits stage left");

  assert.equal(done.waveformVisible, false);
  assert.equal(done.mascotCopy, "top hat bow");

  assert.equal(error.barMode, "expanded");
  assert.equal(error.waveformVisible, false);
  assert.equal(error.mascotCopy, "top hat askew");
  assert.equal(error.toastCopy, undefined);

  assert.equal(erroredWithToast.toastCopy, "Transcription failed.");
});

test("buildOverlaySnapshot exposes exact Mistr Flow status copy for every phase", () => {
  for (const [phase, statusCopy] of Object.entries(expectedStatusCopy)) {
    const snapshot =
      phase === "error"
        ? buildErrorOverlaySnapshot()
        : buildOverlaySnapshot(phase as Parameters<typeof buildOverlaySnapshot>[0]);

    assert.equal(snapshot.statusCopy, statusCopy);
  }
});

test("overlay html contains Mistr Flow card, mascot, state hooks, and reduced motion rules", () => {
  const html = readFileSync(path.join(rootDir, "public", "overlay.html"), "utf8");

  assert.match(html, /id="mistr-flow-overlay"/);
  assert.match(html, /id="mistr-flow-stage"/);
  assert.match(html, /id="mistr-flow-card"/);
  assert.match(html, /data-phase="idle"/);
  assert.match(html, /id="mascot"/);
  assert.match(html, /id="compact-mascot"/);
  assert.match(html, /id="status-copy"/);
  assert.match(html, /class="top-hat"/);
  assert.match(html, /class="moustache"/);
  assert.match(html, /width:\s*280px/);
  assert.match(html, /#mistr-flow-stage[\s\S]*pointer-events:\s*none/);
  assert.match(html, /#mistr-flow-card[\s\S]*pointer-events:\s*auto/);
  assert.match(html, /\.copy[\s\S]*grid-column:\s*2/);
  assert.match(html, /#state-indicator[\s\S]*grid-column:\s*3/);
  assert.match(html, /\.arm[\s\S]*height:\s*24px/);
  assert.match(html, /\.arm[\s\S]*transform:\s*rotate\(-34deg\)/);
  assert.match(html, /\.cane[\s\S]*right:\s*-2px/);
  assert.match(html, /\.cane[\s\S]*width:\s*3px/);
  assert.match(html, /\.microphone[\s\S]*right:\s*-24px/);
  assert.match(html, /\.microphone[\s\S]*z-index:\s*1/);
  assert.match(html, /\.gentleman[\s\S]*z-index:\s*2/);
  assert.match(html, /@keyframes hat-tip/);
  assert.match(html, /@keyframes shoulder-breathe/);
  assert.match(html, /@keyframes cane-twirl/);
  assert.match(html, /@keyframes brush-reveal/);
  assert.match(html, /@keyframes polite-bow/);
  assert.match(html, /@keyframes hat-fall/);
  assert.match(html, /@keyframes exit-stage-left/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*#mistr-flow-stage[\s\S]*display:\s*block/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*#compact-mascot[\s\S]*display:\s*none/);
  assert.doesNotMatch(html, /prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none !important/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*animation-duration:\s*220ms !important/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*data-phase="recording"[\s\S]*animation-duration:\s*1\.1s !important/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*data-phase="recording"[\s\S]*animation-iteration-count:\s*infinite !important/);
});

test("overlay renderer renders status copy, applies data-phase, preserves context menu IPC, and gates mouse input", () => {
  const renderer = readFileSync(
    path.join(rootDir, "public", "overlay-renderer.js"),
    "utf8",
  );

  assert.match(renderer, /statusCopy/);
  assert.match(renderer, /overlayEl\.dataset\.phase\s*=\s*snapshot\.phase/);
  assert.match(renderer, /requestContextMenu\(\)/);
  assert.match(renderer, /setOverlayMouseEvents/);
  assert.match(renderer, /elementFromPoint/);
  assert.match(renderer, /cardEl\.contains/);
});

test("preload and main expose mouse pass-through IPC while keeping the overlay bottom-centered", () => {
  const preload = readFileSync(path.join(rootDir, "public", "preload.js"), "utf8");
  const main = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");

  assert.match(preload, /setOverlayMouseEvents/);
  assert.match(preload, /set-overlay-mouse-events/);
  assert.match(main, /ipcMain\.on\("set-overlay-mouse-events"/);
  assert.match(main, /setIgnoreMouseEvents\(ignore, \{ forward: true \}\)/);
  assert.match(main, /const winWidth = 292/);
  assert.match(main, /const winHeight = 178/);
  assert.match(main, /x: Math\.round\(x \+ \(width - winWidth\) \/ 2\)/);
  assert.match(main, /y: y \+ height - winHeight - 6/);
});

test("runHappyPathOverlaySession advances through real phase boundaries without padding", async () => {
  const states: string[] = [];
  const calls: string[] = [];
  const recordAudio = deferred<Buffer>();
  const transcribe = deferred<string>();
  const polish = deferred<string>();

  const session = runHappyPathOverlaySession({
    showOverlay(snapshot) {
      states.push(snapshot.phase);
    },
    async playBeep() {
      calls.push("beep");
    },
    async recordAudio() {
      calls.push("record");
      return recordAudio.promise;
    },
    async transcribe(audioBuffer) {
      calls.push(`transcribe:${audioBuffer.toString("utf8")}`);
      return transcribe.promise;
    },
    async polish(rawTranscript) {
      calls.push(`polish:${rawTranscript}`);
      return polish.promise;
    },
    async pasteText(text) {
      calls.push(`paste:${text}`);
    },
  });

  await flush();
  assert.deepEqual(states, ["listening", "recording"]);
  assert.deepEqual(calls, ["beep", "record"]);

  recordAudio.resolve(Buffer.from("audio"));
  await flush();
  assert.deepEqual(states, ["listening", "recording", "processing"]);
  assert.deepEqual(calls, ["beep", "record", "transcribe:audio"]);

  transcribe.resolve("raw transcript");
  await flush();
  assert.deepEqual(states, ["listening", "recording", "processing", "polishing"]);
  assert.deepEqual(calls, [
    "beep",
    "record",
    "transcribe:audio",
    "polish:raw transcript",
  ]);

  polish.resolve("polished transcript");
  await flush();
  await session;

  assert.deepEqual(states, [
    "listening",
    "recording",
    "processing",
    "polishing",
    "done",
  ]);
  assert.deepEqual(calls, [
    "beep",
    "record",
    "transcribe:audio",
    "polish:raw transcript",
    "paste:polished transcript",
  ]);
});
