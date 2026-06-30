import { promises as fs } from "node:fs";
import path from "node:path";

import { isFiniteOverlayPosition, type OverlayPosition } from "./overlayPosition";

export interface AppConfig {
  openaiApiKey?: unknown;
  apiKey?: unknown;
  OPENAI_API_KEY?: unknown;
  azureEndpoint?: unknown;
  azureApiKey?: unknown;
  azureApiVersion?: unknown;
  transcribeDeployment?: unknown;
  polishDeployment?: unknown;
  overlayPosition?: unknown;
  muteSystemAudioWhileRecording?: unknown;
  vocabulary?: unknown;
}

export interface AzureOpenAiConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  transcribeDeployment: string;
  polishDeployment: string;
}

const DEFAULT_AZURE_API_VERSION = "2025-04-01-preview";
const DEFAULT_TRANSCRIBE_DEPLOYMENT = "gpt-4o-transcribe";
const DEFAULT_POLISH_DEPLOYMENT = "gpt-5-mini";

export interface VocabularyReplacement {
  wrong: string;
  right: string;
}

export interface VocabularyConfig {
  terms: string[];
  phrases: string[];
  replacements: VocabularyReplacement[];
}

const MAX_TERMS = 200;
const MAX_PHRASES = 100;
const MAX_REPLACEMENTS = 100;
const MAX_STRING_LENGTH = 120;

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is not set; cannot locate MistrFlow config.");
  }

  return path.join(appData, "MistrFlow", "config.json");
}

export async function readAzureOpenAiConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<AzureOpenAiConfig> {
  const configPath = getConfigPath(env);

  let parsed: AppConfig = {};
  try {
    const rawConfig = await fileSystem.readFile(configPath, "utf8");
    if (rawConfig.trim()) parsed = JSON.parse(rawConfig) as AppConfig;
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

export async function readOverlayPosition(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<OverlayPosition | null> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return isFiniteOverlayPosition(parsed.overlayPosition) ? parsed.overlayPosition : null;
}

export async function readVocabularyConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<VocabularyConfig | null> {
  const configPath = getConfigPath(env);

  let rawConfig: string;
  try {
    rawConfig = await fileSystem.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }

  const parsed = JSON.parse(rawConfig) as AppConfig;
  const raw = parsed.vocabulary;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const vocab = raw as {
    enabled?: unknown;
    terms?: unknown;
    phrases?: unknown;
    replacements?: unknown;
  };

  if (vocab.enabled === false) return null;

  const terms = normalizeStringArray(vocab.terms).slice(0, MAX_TERMS);
  const phrases = normalizeStringArray(vocab.phrases).slice(0, MAX_PHRASES);
  const replacements = normalizeReplacements(vocab.replacements).slice(0, MAX_REPLACEMENTS);

  if (terms.length === 0 && phrases.length === 0 && replacements.length === 0) return null;

  return { terms, phrases, replacements };
}

export async function readMuteSystemAudioWhileRecording(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<boolean> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return parsed.muteSystemAudioWhileRecording !== false;
}

export async function writeOverlayPosition(
  position: OverlayPosition,
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<void> {
  const configPath = getConfigPath(env);
  let parsed: AppConfig = {};

  try {
    const raw = await fileSystem.readFile(configPath, "utf8");
    if (raw.trim()) parsed = JSON.parse(raw) as AppConfig;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      // file doesn't exist yet — start from empty config
    } else if (error instanceof SyntaxError) {
      // transient truncated write while dragging — start from empty config
    } else {
      throw error;
    }
  }

  await fileSystem.mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = configPath + ".tmp";
  await fileSystem.writeFile(
    tmpPath,
    JSON.stringify({ ...parsed, overlayPosition: position }, null, 2),
    "utf8",
  );
  await fileSystem.rename(tmpPath, configPath);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, MAX_STRING_LENGTH);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeReplacements(value: unknown): VocabularyReplacement[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: VocabularyReplacement[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { wrong, right } = item as { wrong?: unknown; right?: unknown };
    if (typeof wrong !== "string" || typeof right !== "string") continue;
    const w = wrong.trim().slice(0, MAX_STRING_LENGTH);
    const r = right.trim().slice(0, MAX_STRING_LENGTH);
    if (!w || !r || seen.has(w)) continue;
    seen.add(w);
    result.push({ wrong: w, right: r });
  }
  return result;
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
