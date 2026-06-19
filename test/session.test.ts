import assert from "node:assert/strict";
import test from "node:test";

import { runSession } from "../src/session";

test("runSession returns polished text when both calls succeed", async () => {
  const calls: Array<string> = [];
  const result = await runSession(Buffer.from("audio"), {
    async transcribe() {
      calls.push("transcribe");
      return "raw transcript";
    },
    async polish(rawTranscript) {
      calls.push(`polish:${rawTranscript}`);
      return "polished transcript";
    },
  });

  assert.deepEqual(calls, ["transcribe", "polish:raw transcript"]);
  assert.deepEqual(result, {
    kind: "polished",
    rawTranscript: "raw transcript",
    polishedText: "polished transcript",
  });
});

test("runSession falls back to the raw transcript when Polish fails", async () => {
  const result = await runSession(Buffer.from("audio"), {
    async transcribe() {
      return "raw transcript";
    },
    async polish() {
      throw new Error("polish failed");
    },
  });

  assert.equal(result.kind, "raw-fallback");
  if (result.kind !== "raw-fallback") {
    throw new Error("Expected raw-fallback result.");
  }

  assert.equal(result.rawTranscript, "raw transcript");
  assert.equal(result.polishError.message, "polish failed");
});

test("runSession reports a hard error when transcription fails", async () => {
  const calls: Array<string> = [];
  const result = await runSession(Buffer.from("audio"), {
    async transcribe() {
      calls.push("transcribe");
      throw new Error("transcription failed");
    },
    async polish() {
      calls.push("polish");
      return "should not be used";
    },
  });

  assert.deepEqual(calls, ["transcribe"]);
  assert.equal(result.kind, "hard-error");
  if (result.kind !== "hard-error") {
    throw new Error("Expected hard-error result.");
  }

  assert.equal(result.error.message, "transcription failed");
});
