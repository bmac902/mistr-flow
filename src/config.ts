import { promises as fs } from "node:fs";
import path from "node:path";

import { isFiniteOverlayPosition, type OverlayPosition } from "./overlayPosition";

export interface AppConfig {
  openaiApiKey?: unknown;
  apiKey?: unknown;
  OPENAI_API_KEY?: unknown;
  overlayPosition?: unknown;
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

export async function readOverlayPosition(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<OverlayPosition | null> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return isFiniteOverlayPosition(parsed.overlayPosition) ? parsed.overlayPosition : null;
}

export async function writeOverlayPosition(
  position: OverlayPosition,
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<void> {
  const configPath = getConfigPath(env);
  let parsed: AppConfig = {};

  try {
    parsed = JSON.parse(await fileSystem.readFile(configPath, "utf8")) as AppConfig;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  await fileSystem.mkdir(path.dirname(configPath), { recursive: true });
  await fileSystem.writeFile(
    configPath,
    JSON.stringify({ ...parsed, overlayPosition: position }, null, 2),
    "utf8",
  );
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
