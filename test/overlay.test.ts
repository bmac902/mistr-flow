import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOverlaySnapshot,
  buildErrorOverlaySnapshot,
  runHappyPathOverlaySession,
} from "../src/overlay";

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
  const done = buildOverlaySnapshot("done");
  const error = buildErrorOverlaySnapshot();
  const erroredWithToast = buildErrorOverlaySnapshot("Transcription failed.");

  assert.equal(idle.barMode, "peek");
  assert.equal(idle.waveformVisible, false);
  assert.equal(idle.mascotCopy, "hat + eyes");

  assert.equal(listening.barMode, "expanded");
  assert.equal(listening.waveformVisible, true);
  assert.equal(listening.mascotCopy, "listening");

  assert.equal(recording.waveformVisible, true);
  assert.equal(recording.mascotCopy, "recording");

  assert.equal(processing.waveformVisible, false);
  assert.equal(processing.mascotCopy, "processing");

  assert.equal(polishing.waveformVisible, false);
  assert.equal(polishing.mascotCopy, "polishing");

  assert.equal(done.waveformVisible, false);
  assert.equal(done.mascotCopy, "done");

  assert.equal(error.barMode, "expanded");
  assert.equal(error.waveformVisible, false);
  assert.equal(error.mascotCopy, "error");
  assert.equal(error.toastCopy, undefined);

  assert.equal(erroredWithToast.toastCopy, "Transcription failed.");
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
