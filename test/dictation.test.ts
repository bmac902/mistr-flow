import assert from "node:assert/strict";
import test from "node:test";

import {
  createDictationCancelledError,
  runDictationSession,
} from "../src/dictation";
import type { OverlaySnapshot } from "../src/overlay";

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

test("runDictationSession drives the happy path from recording through paste", async () => {
  const states: string[] = [];
  const calls: string[] = [];
  const recordAudio = deferred<Buffer>();
  const transcribe = deferred<string>();
  const polish = deferred<string>();

  const session = runDictationSession({
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
      calls.push(`transcribe:${audioBuffer.length}`);
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

  recordAudio.resolve(Buffer.alloc(200));
  await flush();
  assert.deepEqual(states, ["listening", "recording", "processing"]);
  assert.deepEqual(calls, ["beep", "record", "transcribe:200"]);

  transcribe.resolve("raw transcript");
  await flush();
  assert.deepEqual(states, ["listening", "recording", "processing", "polishing"]);
  assert.deepEqual(calls, [
    "beep",
    "record",
    "transcribe:200",
    "polish:raw transcript",
  ]);

  polish.resolve("polished transcript");
  await flush();
  const result = await session;

  assert.equal(result.kind, "polished");
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
    "transcribe:200",
    "polish:raw transcript",
    "paste:polished transcript",
  ]);
});

test("runDictationSession silently cancels when the audio buffer is empty", async () => {
  const states: string[] = [];
  const calls: string[] = [];
  const recordAudio = deferred<Buffer>();

  const session = runDictationSession({
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
    async transcribe() {
      calls.push("transcribe");
      return "should not be used";
    },
    async polish() {
      calls.push("polish");
      return "should not be used";
    },
    async pasteText(text) {
      calls.push(`paste:${text}`);
    },
  });

  await flush();
  recordAudio.resolve(Buffer.alloc(0));

  const result = await session;

  assert.deepEqual(states, ["listening", "recording", "cancelled"]);
  assert.deepEqual(calls, ["beep", "record"]);
  assert.deepEqual(result, { kind: "cancelled", reason: "dead-zone" });
});

test("runDictationSession cancels in the dead zone without API calls or paste", async () => {
  const states: string[] = [];
  const calls: string[] = [];
  const recordAudio = deferred<Buffer>();

  const session = runDictationSession({
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
    async transcribe() {
      calls.push("transcribe");
      return "should not be used";
    },
    async polish() {
      calls.push("polish");
      return "should not be used";
    },
    async pasteText(text) {
      calls.push(`paste:${text}`);
    },
  });

  await flush();
  recordAudio.reject(createDictationCancelledError("dead-zone"));

  const result = await session;

  assert.deepEqual(states, ["listening", "recording", "cancelled"]);
  assert.deepEqual(calls, ["beep", "record"]);
  assert.deepEqual(result, {
    kind: "cancelled",
    reason: "dead-zone",
  });
});

test("runDictationSession cancels an in-progress recording on Escape", async () => {
  const states: string[] = [];
  const calls: string[] = [];
  const recordAudio = deferred<Buffer>();

  const session = runDictationSession({
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
    async transcribe() {
      calls.push("transcribe");
      return "should not be used";
    },
    async polish() {
      calls.push("polish");
      return "should not be used";
    },
    async pasteText(text) {
      calls.push(`paste:${text}`);
    },
  });

  await flush();
  recordAudio.reject(createDictationCancelledError("escape"));

  const result = await session;

  assert.deepEqual(states, ["listening", "recording", "cancelled"]);
  assert.deepEqual(calls, ["beep", "record"]);
  assert.deepEqual(result, {
    kind: "cancelled",
    reason: "escape",
  });
});

test("runDictationSession pastes the raw transcript when Polish fails", async () => {
  const states: string[] = [];
  const calls: string[] = [];
  const recordAudio = deferred<Buffer>();
  const transcribe = deferred<string>();

  const session = runDictationSession({
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
      calls.push(`transcribe:${audioBuffer.length}`);
      return transcribe.promise;
    },
    async polish() {
      throw new Error("polish failed");
    },
    async pasteText(text) {
      calls.push(`paste:${text}`);
    },
  });

  await flush();
  recordAudio.resolve(Buffer.alloc(200));
  await flush();
  transcribe.resolve("raw transcript");
  await flush();

  const result = await session;

  assert.equal(result.kind, "raw-fallback");
  assert.deepEqual(states, [
    "listening",
    "recording",
    "processing",
    "polishing",
    "error",
  ]);
  assert.deepEqual(calls, [
    "beep",
    "record",
    "transcribe:200",
    "paste:raw transcript",
  ]);
});

test("runDictationSession does not paste anything when transcription fails", async () => {
  const states: string[] = [];
  const calls: string[] = [];
  const recordAudio = deferred<Buffer>();
  let errorSnapshot: OverlaySnapshot | undefined;

  const session = runDictationSession({
    showOverlay(snapshot) {
      states.push(snapshot.phase);
      if (snapshot.phase === "error") {
        errorSnapshot = snapshot;
      }
    },
    async playBeep() {
      calls.push("beep");
    },
    async recordAudio() {
      calls.push("record");
      return recordAudio.promise;
    },
    async transcribe(audioBuffer) {
      calls.push(`transcribe:${audioBuffer.length}`);
      throw new Error("transcription failed");
    },
    async polish() {
      calls.push("polish");
      return "should not be used";
    },
    async pasteText(text) {
      calls.push(`paste:${text}`);
    },
  });

  await flush();
  recordAudio.resolve(Buffer.alloc(200));
  await flush();

  const result = await session;

  assert.equal(result.kind, "hard-error");
  assert.deepEqual(states, ["listening", "recording", "processing", "error"]);
  assert.equal(errorSnapshot?.toastCopy, "transcription failed");
  assert.deepEqual(calls, ["beep", "record", "transcribe:200"]);
});
