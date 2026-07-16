import { createAzureProvider } from "./azureProvider";
import { createOpenAiProvider } from "./openaiProvider";

/**
 * The entire surface Mistr Flow needs from an AI provider — the two calls the
 * dictation session makes, and nothing speculative. Shaped from the real call
 * sites in main.ts. Every provider (OpenAI today, Azure on the work fork) is a
 * self-contained file that implements this port; the fork exists only because
 * this seam didn't (issue #43).
 */
export interface AiProvider {
  transcribe(
    audio: Buffer,
    opts: { vocabularyPrompt: string | null },
  ): Promise<string>;
  polish(
    rawTranscript: string,
    opts: { vocabularyInstruction: string | null },
  ): Promise<string>;
}

/**
 * Builds a provider. Each factory reads its OWN config (the OpenAI factory
 * reads openaiApiKey; a future Azure factory reads azureEndpoint & friends) —
 * that's what keeps config.ts out of the fork's merge-conflict zone forever.
 */
export type AiProviderFactory = () => Promise<AiProvider>;

/**
 * The registry is the extension point: a new provider slots in as one entry
 * here plus its own adapter file — main.ts, config.ts, and the dictation
 * session never change. This is where Azure lands (`azure: () => createAzureProvider()`).
 */
export const defaultAiProviderRegistry: Record<string, AiProviderFactory> = {
  openai: () => createOpenAiProvider(),
  azure: () => createAzureProvider(),
};

/**
 * Resolves a provider by name. An unrecognised value fails loudly, naming the
 * supported providers — never a silent fallback to OpenAI. A typo'd provider
 * quietly billing the wrong vendor's key is exactly the failure this guards.
 */
export async function resolveAiProvider(
  name: string,
  registry: Record<string, AiProviderFactory> = defaultAiProviderRegistry,
): Promise<AiProvider> {
  const factory = registry[name];
  if (!factory) {
    const supported = Object.keys(registry).sort().join(", ");
    throw new Error(
      `Unknown AI provider "${name}". Supported providers: ${supported}.`,
    );
  }
  return factory();
}
