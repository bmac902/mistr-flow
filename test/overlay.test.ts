import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  buildCancelledOverlaySnapshot,
  buildCaptureDeliveryFailedOverlaySnapshot,
  buildCapturePickerOverlaySnapshot,
  buildOverlaySnapshot,
  buildErrorOverlaySnapshot,
  buildRefusedOverlaySnapshot,
  runHappyPathOverlaySession,
} from "../src/overlay";
import type { EligibleTarget } from "../src/herdr";

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
  refused: "One thing at a time, sir.",
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

  const refused = buildRefusedOverlaySnapshot();
  assert.equal(refused.barMode, "expanded");
  assert.equal(refused.waveformVisible, false);
  assert.equal(refused.mascotCopy, "wags a scolding finger");
});

test("buildOverlaySnapshot exposes exact Mistr Flow status copy for every phase", () => {
  for (const [phase, statusCopy] of Object.entries(expectedStatusCopy)) {
    const snapshot =
      phase === "error"
        ? buildErrorOverlaySnapshot()
        : phase === "refused"
          ? buildRefusedOverlaySnapshot()
          : buildOverlaySnapshot(phase as Parameters<typeof buildOverlaySnapshot>[0]);

    assert.equal(snapshot.statusCopy, statusCopy);
  }
});

test("buildOverlaySnapshot pins placeholder copy for every Capture phase (issue #30, PRD #24)", () => {
  const target: EligibleTarget = {
    target: "herdr-session-a",
    label: "claude · idle — pane a",
    agentStatus: "idle",
  };

  const summoning = buildCapturePickerOverlaySnapshot([]);
  assert.equal(summoning.phase, "capture-picker");
  assert.equal(summoning.statusCopy, "Summoning targets…");
  assert.deepEqual(summoning.captureTargets, []);
  assert.equal(summoning.toastCopy, undefined);

  const populated = buildCapturePickerOverlaySnapshot([target]);
  assert.equal(populated.statusCopy, "Pick your target, sir.");
  assert.deepEqual(populated.captureTargets, [target]);

  const localOnly = buildCapturePickerOverlaySnapshot(
    [],
    "Herdr isn't installed or running — Clipboard only, sir.",
  );
  assert.equal(localOnly.statusCopy, "Pick your target, sir.");
  assert.equal(
    localOnly.toastCopy,
    "Herdr isn't installed or running — Clipboard only, sir.",
  );

  const delivering = buildOverlaySnapshot("capture-delivering");
  assert.equal(delivering.statusCopy, "Delivering to the pane…");

  const delivered = buildOverlaySnapshot("capture-delivered");
  assert.equal(delivered.statusCopy, "Delivered, sir.");

  const deliveryUnknown = buildOverlaySnapshot("capture-delivery-unknown");
  assert.equal(
    deliveryUnknown.statusCopy,
    "Not sure that landed — try again?",
  );

  const deliveryFailed = buildCaptureDeliveryFailedOverlaySnapshot(
    "That pane has left the building.",
  );
  assert.equal(deliveryFailed.phase, "capture-delivery-failed");
  assert.equal(deliveryFailed.statusCopy, "That pane didn't take it.");
  assert.equal(deliveryFailed.toastCopy, "That pane has left the building.");
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
  assert.doesNotMatch(html, /🎩|⌒⌒/);
  assert.match(html, /viewBox="0 0 40 40"/);
  assert.match(html, /class="mf-hat"/);
  assert.match(html, /class="mf-moustache"/);
  assert.match(html, /viewBox="0 0 160 185"/);
  assert.match(html, /\.mf-hat[\s\S]*transform-box:\s*fill-box/);
  assert.match(html, /\.mf-hat[\s\S]*transform-origin:\s*50% 88%/);
  assert.match(html, /width:\s*280px/);
  assert.match(html, /#mistr-flow-stage[\s\S]*pointer-events:\s*none/);
  assert.match(html, /#mistr-flow-card[\s\S]*pointer-events:\s*auto/);
  assert.match(html, /\.copy[\s\S]*grid-column:\s*2/);
  assert.match(html, /#state-indicator[\s\S]*grid-column:\s*3/);
  assert.match(html, /class="mf-arm"/);
  assert.match(html, /class="mf-cane"/);
  assert.match(html, /class="mf-recording-only"/);
  assert.match(html, /class="mf-polishing-only"/);
  assert.match(html, /id="indicator-polishing"/);
  assert.match(html, /id="indicator-cancelled"/);
  assert.match(html, /\.mf-state-polishing #indicator-polishing/);
  assert.match(html, /\.mf-state-cancelled #indicator-cancelled/);
  assert.match(html, /\.mf-arm[\s\S]*transform-origin:\s*0% 0%/);
  assert.match(html, /\.mf-cane[\s\S]*transform-origin:\s*42% 6%/);
  assert.match(html, /@keyframes mf-tiphat/);
  assert.match(html, /@keyframes mf-breathe/);
  assert.match(html, /@keyframes mf-twirl/);
  assert.match(html, /@keyframes mf-brush/);
  assert.match(html, /@keyframes mf-bow/);
  assert.match(html, /@keyframes mf-hatfall/);
  assert.match(html, /@keyframes mf-exit/);
  assert.match(html, /100%\s*\{ transform: translateX\(-58px\); opacity: 0; \}/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*#mistr-flow-stage[\s\S]*display:\s*block/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*#compact-mascot[\s\S]*display:\s*block/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none !important/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*\.mf-state-cancelled \.mf-figure[\s\S]*opacity:\s*0/);
  assert.match(html, /prefers-reduced-motion:\s*reduce[\s\S]*\.mf-indicator-dot/);
});

test("overlay renderer renders status copy, applies data-phase, preserves context menu IPC, gates mouse input, and wires drag events", () => {
  const renderer = readFileSync(
    path.join(rootDir, "public", "overlay-renderer.js"),
    "utf8",
  );

  assert.match(renderer, /statusCopy/);
  assert.match(renderer, /overlayEl\.dataset\.phase\s*=\s*snapshot\.phase/);
  assert.match(renderer, /overlayEl\.classList\.add\(`mf-state-\$\{snapshot\.phase\}`\)/);
  assert.match(renderer, /mascotEl\.classList\.add\(`mf-state-\$\{snapshot\.phase\}`\)/);
  assert.match(renderer, /requestContextMenu\(\)/);
  assert.match(renderer, /setOverlayMouseEvents/);
  assert.match(renderer, /elementFromPoint/);
  assert.match(renderer, /cardEl\.contains/);
  assert.match(renderer, /pointerdown/);
  assert.match(renderer, /pointermove/);
  assert.match(renderer, /pointerup/);
  assert.match(renderer, /moveOverlayBy/);
  assert.match(renderer, /event\.button\s*!==\s*0/);
});

test("preload and main expose mouse pass-through and overlay movement IPC", () => {
  const preload = readFileSync(path.join(rootDir, "public", "preload.js"), "utf8");
  const main = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");

  assert.match(preload, /setOverlayMouseEvents/);
  assert.match(preload, /set-overlay-mouse-events/);
  assert.match(preload, /moveOverlayBy/);
  assert.match(preload, /move-overlay-by/);
  assert.match(main, /ipcMain\.on\("set-overlay-mouse-events"/);
  assert.match(main, /ipcMain\.on\("move-overlay-by"/);
  assert.match(main, /setIgnoreMouseEvents\(ignore, \{ forward: true \}\)/);
  assert.match(main, /const winWidth = 292/);
  assert.match(main, /const winHeight = 178/);
  assert.match(main, /resolveOverlayPosition/);
  assert.match(main, /writeOverlayPosition/);
  assert.match(main, /ensureOverlayStaysOnTop/);
  assert.match(main, /moveTop\(\)/);
  assert.match(main, /cleanupPromise: Promise<void> \| null/);
  assert.match(main, /beginSessionCleanup/);
  assert.match(main, /app\.on\("before-quit"/);
  assert.match(main, /quitAfterSessionCleanup/);
});

test("main consults the authoritative active-verb lock before starting dictation and releases it on cleanup", () => {
  const main = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");

  assert.match(main, /createActiveVerbLock/);
  assert.match(main, /verbLock\.tryStart\("dictation"\)/);
  assert.match(main, /verbLock\.release\("dictation"\)/);
  assert.match(main, /buildRefusedOverlaySnapshot/);
});

test("reusable design components gate animation completion to deterministic finite animations", () => {
  const overlay = readFileSync(
    path.join(rootDir, "docs", "design", "assets", "code", "MistrFlowOverlay.tsx"),
    "utf8",
  );
  const mascot = readFileSync(
    path.join(rootDir, "docs", "design", "assets", "code", "MistrFlowMascot.tsx"),
    "utf8",
  );

  assert.doesNotMatch(overlay, /OVERLAY_COMPLETION_SELECTORS/);
  assert.match(overlay, /ANIMATION_DURATION_MS/);
  assert.match(overlay, /window\.setTimeout[\s\S]*onAnimationComplete\(state\)[\s\S]*durationMs/);
  assert.match(overlay, /window\.clearTimeout\(timeoutId\)/);
  assert.match(overlay, /LOOPING_STATES\.has\(state\)/);
  assert.match(overlay, /completedStateRef\.current === state/);
  assert.doesNotMatch(overlay, /target\.matches\(completionSelector\)/);
  assert.doesNotMatch(overlay, /cancelled: '\.mf-indicator-cancelled'/);

  assert.match(mascot, /MASCOT_COMPLETION_SELECTORS/);
  assert.match(mascot, /completedStateRef\.current === state/);
  assert.match(mascot, /polishing: '\.mf-words-clean'/);
  assert.match(mascot, /cancelled: '\.mf-figure'/);
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
