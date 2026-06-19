import { promises as fs } from "node:fs";
import path from "node:path";

export interface AppConfig {
  openaiApiKey?: unknown;
  apiKey?: unknown;
  OPENAI_API_KEY?: unknown;
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is not set; cannot locate MistrFlow config.");
  }

  return path.join(appData, "MistrFlow", "config.json");
}

export async function readOpenAiApiKey(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<string> {
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim()) {
    return env.OPENAI_API_KEY.trim();
  }

  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  const apiKey = pickApiKey(parsed);

  if (!apiKey) {
    throw new Error(
      `Missing openaiApiKey in ${configPath}. Expected a JSON string field.`,
    );
  }

  return apiKey;
}

function pickApiKey(config: AppConfig): string | null {
  const candidates = [config.openaiApiKey, config.apiKey, config.OPENAI_API_KEY];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}
