import assert from "node:assert/strict";
import test from "node:test";

import type { AiProvider } from "../src/aiProvider";
import { resolveAiProvider } from "../src/aiProvider";
import { runDictationSession } from "../src/dictation";

function fakeProvider(marker: string): AiProvider {
  return {
    transcribe: async () => `${marker}:transcribed`,
    polish: async (raw) => `${marker}:polished:${raw}`,
  };
}

test("resolveAiProvider builds the provider its registry names", async () => {
  const provider = await resolveAiProvider("fake", {
    fake: async () => fakeProvider("fake"),
  });

  assert.equal(
    await provider.transcribe(Buffer.from("audio"), { vocabularyPrompt: null }),
    "fake:transcribed",
  );
  assert.equal(
    await provider.polish("hi", { vocabularyInstruction: null }),
    "fake:polished:hi",
  );
});

test("resolveAiProvider fails loudly on an unknown provider, naming what is supported", async () => {
  await assert.rejects(
    resolveAiProvider("azreu", {
      openai: async () => fakeProvider("openai"),
      azure: async () => fakeProvider("azure"),
    }),
    (error: Error) => {
      assert.match(error.message, /azreu/);
      assert.match(error.message, /openai/);
      assert.match(error.message, /azure/);
      return true;
    },
  );
});

test("resolveAiProvider never silently falls back to openai for an unknown value", async () => {
  let openaiBuilt = false;
  await assert.rejects(
    resolveAiProvider("nope", {
      openai: async () => {
        openaiBuilt = true;
        return fakeProvider("openai");
      },
    }),
  );
  assert.equal(openaiBuilt, false);
});

// The criterion that actually proves the fork can die: a second provider,
// injected purely through the port, drives dictation end-to-end without any
// change to main.ts, config.ts, or the dictation session.
test("a fake provider injected through the port drives a dictation session", async () => {
  const provider = await resolveAiProvider("fake", {
    fake: async () => fakeProvider("fake"),
  });

  let pasted: string | null = null;
  const result = await runDictationSession({
    showOverlay: () => {},
    playBeep: () => {},
    recordAudio: async () => Buffer.alloc(200),
    transcribe: (audio) => provider.transcribe(audio, { vocabularyPrompt: null }),
    polish: (raw) => provider.polish(raw, { vocabularyInstruction: null }),
    pasteText: (text) => {
      pasted = text;
    },
  });

  assert.equal(result.kind, "polished");
  assert.equal(pasted, "fake:polished:fake:transcribed");
});
