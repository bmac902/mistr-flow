import { promises as fs } from "node:fs";

import type { AiProvider } from "./aiProvider";
import { polishTranscript, transcribeAudio } from "./azure";
import { getConfigPath, type AppConfig } from "./config";

export interface AzureProviderDeps {
  env?: NodeJS.ProcessEnv;
  fileSystem?: typeof fs;
  fetchImpl?: typeof fetch;
}

/**
 * The Azure AI Foundry adapter behind the AiProvider port. It reads its OWN
 * config fields (azureEndpoint, azureApiKey, azureApiVersion,
 * transcribeDeployment, polishDeployment) and delegates to the proven azure.ts
 * transcribe/polish calls. config.ts deliberately knows none of these field
 * names — that is what keeps config.ts out of the fork's merge-conflict zone
 * (issue #43). This code was the fork's raison d'être; behind the port, the
 * fork dies (one codebase, `"provider": "azure"` on this machine).
 */
export async function createAzureProvider(
  deps: AzureProviderDeps = {},
): Promise<AiProvider> {
  const config = await readAzureConfig(deps.env, deps.fileSystem ?? fs);

  return {
    transcribe: (audio, opts) =>
      transcribeAudio(audio, {
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        apiVersion: config.apiVersion,
        deployment: config.transcribeDeployment,
        vocabularyPrompt: opts.vocabularyPrompt,
        fetchImpl: deps.fetchImpl,
      }),
    polish: (rawTranscript, opts) =>
      polishTranscript(rawTranscript, {
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        apiVersion: config.apiVersion,
        deployment: config.polishDeployment,
        vocabularyInstruction: opts.vocabularyInstruction,
        fetchImpl: deps.fetchImpl,
      }),
  };
}

interface AzureConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  transcribeDeployment: string;
  polishDeployment: string;
}

/** Fields this adapter reads. Intentionally NOT in config.ts's AppConfig. */
interface AzureAppConfig extends AppConfig {
  azureEndpoint?: unknown;
  azureApiKey?: unknown;
  azureApiVersion?: unknown;
  transcribeDeployment?: unknown;
  polishDeployment?: unknown;
}

const DEFAULT_AZURE_API_VERSION = "2025-04-01-preview";
const DEFAULT_TRANSCRIBE_DEPLOYMENT = "gpt-4o-transcribe";
const DEFAULT_POLISH_DEPLOYMENT = "gpt-5-mini";

async function readAzureConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<AzureConfig> {
  const configPath = getConfigPath(env);

  let parsed: AzureAppConfig = {};
  try {
    const rawConfig = await fileSystem.readFile(configPath, "utf8");
    if (rawConfig.trim()) parsed = JSON.parse(rawConfig) as AzureAppConfig;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }

  const endpoint = pickString(env.AZURE_OPENAI_ENDPOINT, parsed.azureEndpoint);
  if (!endpoint) {
    throw new Error(
      `Missing azureEndpoint in ${configPath} (or AZURE_OPENAI_ENDPOINT). ` +
        `Expected your Azure AI Foundry endpoint, e.g. https://<resource>.cognitiveservices.azure.com/.`,
    );
  }

  const apiKey = pickString(
    env.AZURE_OPENAI_API_KEY,
    parsed.azureApiKey,
    parsed.apiKey,
    parsed.openaiApiKey,
    parsed.OPENAI_API_KEY,
  );
  if (!apiKey) {
    throw new Error(
      `Missing azureApiKey in ${configPath} (or AZURE_OPENAI_API_KEY). Expected a JSON string field.`,
    );
  }

  return {
    endpoint,
    apiKey,
    apiVersion:
      pickString(env.AZURE_OPENAI_API_VERSION, parsed.azureApiVersion) ??
      DEFAULT_AZURE_API_VERSION,
    transcribeDeployment:
      pickString(parsed.transcribeDeployment) ?? DEFAULT_TRANSCRIBE_DEPLOYMENT,
    polishDeployment:
      pickString(parsed.polishDeployment) ?? DEFAULT_POLISH_DEPLOYMENT,
  };
}

function pickString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
