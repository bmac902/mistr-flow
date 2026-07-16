import { promises as fs } from "node:fs";

import type { AiProvider } from "./aiProvider";
import { readOpenAiApiKey } from "./config";
import { polishTranscript, transcribeAudio } from "./openai";

export interface OpenAiProviderDeps {
  env?: NodeJS.ProcessEnv;
  fileSystem?: typeof fs;
  fetchImpl?: typeof fetch;
}

/**
 * The OpenAI adapter behind the AiProvider port. It reads its own config
 * (`openaiApiKey`) and delegates to the unchanged openai.ts Whisper/Polish
 * calls — behaviour is byte-identical to the pre-seam wiring. A future Azure
 * adapter is a sibling file that reads Azure's own config; neither touches the
 * other, and config.ts learns neither's fields (issue #43).
 */
export async function createOpenAiProvider(
  deps: OpenAiProviderDeps = {},
): Promise<AiProvider> {
  const apiKey = await readOpenAiApiKey(deps.env, deps.fileSystem ?? fs);

  return {
    transcribe: (audio, opts) =>
      transcribeAudio(audio, {
        apiKey,
        vocabularyPrompt: opts.vocabularyPrompt,
        fetchImpl: deps.fetchImpl,
      }),
    polish: (rawTranscript, opts) =>
      polishTranscript(rawTranscript, {
        apiKey,
        vocabularyInstruction: opts.vocabularyInstruction,
        fetchImpl: deps.fetchImpl,
      }),
  };
}
