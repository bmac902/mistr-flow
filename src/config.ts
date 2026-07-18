import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeAppTargets, type AppTarget } from "./appTargets";
import { isFiniteOverlayPosition, type OverlayPosition } from "./overlayPosition";
import { normalizeProjectAnchors, type ProjectAnchor } from "./projectAnchors";

export interface AppConfig {
  openaiApiKey?: unknown;
  apiKey?: unknown;
  OPENAI_API_KEY?: unknown;
  overlayPosition?: unknown;
  muteSystemAudioWhileRecording?: unknown;
  vocabulary?: unknown;
  focusOnDeliver?: unknown;
  copySelectionFirst?: unknown;
  persistentBlockDing?: unknown;
  doneChime?: unknown;
  provider?: unknown;
  projectAnchors?: unknown;
  appTargets?: unknown;
}

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

/**
 * Opt-in only — defaults to false. Focusing the delivered-to pane after a
 * successful Capture delivery is a deliberate exception to "never steal
 * focus": unlike the delivery mechanism itself (which never needs focus),
 * this is a user-chosen convenience, off by default (CONTEXT.md, 2026-07-15).
 */
export async function readFocusOnDeliver(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<boolean> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return parsed.focusOnDeliver === true;
}

/**
 * Opt-in only — defaults to false. When true, the Relay hotkey simulates
 * Ctrl+C first, so a *selection* is grabbed without an explicit copy: select →
 * hotkey → digit, one keystroke saved. Footgun (mitigated by the picker
 * preview, which shows exactly what will be sent): if nothing is selected the
 * simulated copy no-ops and the existing clipboard is relayed instead — visible
 * and Esc-able rather than silent. Off by default so the safe read-existing-
 * clipboard behaviour is the baseline.
 */
export async function readCopySelectionFirst(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<boolean> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return parsed.copySelectionFirst === true;
}

/**
 * Default ON, silenceable — mirrors readMuteSystemAudioWhileRecording's
 * `!== false` shape. The persistent-block ding (PRD #44, #51) is the feature's
 * one active cue; a user can kill the sound while keeping the visual fleet
 * awareness by setting `persistentBlockDing: false`. On by default so the value
 * isn't hidden behind a flag nobody discovers.
 */
export async function readPersistentBlockDing(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<boolean> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return parsed.persistentBlockDing !== false;
}

/**
 * Default ON, silenceable — mirrors readPersistentBlockDing's `!== false` shape
 * (ADR 0006 §2). The one soft done chime rides the same fleet-awareness master
 * behavior as the ding; `doneChime: false` keeps the ambient done badge and the
 * jump gesture while killing only the sound. On by default so the value isn't
 * hidden behind a flag nobody discovers.
 */
export async function readDoneChime(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<boolean> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return parsed.doneChime !== false;
}

/**
 * Which AI provider to resolve at startup, defaulting to "openai" when absent
 * so every config already in the wild keeps working untouched. This reads only
 * the provider *name* — provider-specific fields (openaiApiKey, and a future
 * Azure adapter's own fields) are read by each adapter's factory, never here.
 * That's the seam that keeps config.ts out of the fork's conflict zone (#43).
 */
export async function readProvider(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<string> {
  const configPath = getConfigPath(env);
  const rawConfig = await fileSystem.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig) as AppConfig;
  return typeof parsed.provider === "string" && parsed.provider.trim()
    ? parsed.provider.trim()
    : "openai";
}

/**
 * Per-machine, deliberately never source (project-anchors design, 2026-07-17):
 * Mistr Flow runs on two machines with different project sets, and MF learns
 * no project semantics — each machine's config names its own projects. Missing
 * file or key is an empty list, never fatal: rows simply fall back to the raw
 * cwd basename until anchors are configured.
 */
export async function readProjectAnchors(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<ProjectAnchor[]> {
  const configPath = getConfigPath(env);

  let rawConfig: string;
  try {
    rawConfig = await fileSystem.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const parsed = JSON.parse(rawConfig) as AppConfig;
  return normalizeProjectAnchors(parsed.projectAnchors);
}

/**
 * Per-machine, deliberately never source (app-targets design, 2026-07-17):
 * Mistr Flow runs on machines with different apps installed, and MF learns no
 * app semantics — each machine's config names its own relay targets (e.g.
 * ChatGPT). Missing file or key is an empty list, never fatal: the picker
 * simply offers no app targets until they're configured. Mirrors
 * {@link readProjectAnchors}.
 */
export async function readAppTargets(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem = fs,
): Promise<AppTarget[]> {
  const configPath = getConfigPath(env);

  let rawConfig: string;
  try {
    rawConfig = await fileSystem.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const parsed = JSON.parse(rawConfig) as AppConfig;
  return normalizeAppTargets(parsed.appTargets);
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
