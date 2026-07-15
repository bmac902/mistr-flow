import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getConfigPath,
  readAzureOpenAiConfig,
  readFocusOnDeliver,
  readMuteSystemAudioWhileRecording,
  readOverlayPosition,
  readVocabularyConfig,
  writeOverlayPosition,
} from "../src/config";

async function writeConfig(contents: Record<string, unknown>): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify(contents), "utf8");
  return tempRoot;
}

test("getConfigPath resolves the Windows config location from APPDATA", () => {
  const configPath = getConfigPath({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" });

  assert.equal(
    configPath,
    path.join("C:\\Users\\alice\\AppData\\Roaming", "MistrFlow", "config.json"),
  );
});

test("readAzureOpenAiConfig reads endpoint and key and applies deployment defaults", async () => {
  const tempRoot = await writeConfig({
    azureEndpoint: "https://example.cognitiveservices.azure.com/",
    azureApiKey: "azure-key",
  });

  const config = await readAzureOpenAiConfig({ APPDATA: tempRoot }, fs);

  assert.deepEqual(config, {
    endpoint: "https://example.cognitiveservices.azure.com/",
    apiKey: "azure-key",
    apiVersion: "2025-04-01-preview",
    transcribeDeployment: "gpt-4o-transcribe",
    polishDeployment: "gpt-5-mini",
  });
});

test("readAzureOpenAiConfig honors explicit deployments and api-version", async () => {
  const tempRoot = await writeConfig({
    azureEndpoint: "https://example.cognitiveservices.azure.com/",
    azureApiKey: "azure-key",
    azureApiVersion: "2025-03-01-preview",
    transcribeDeployment: "whisper",
    polishDeployment: "gpt-4o",
  });

  const config = await readAzureOpenAiConfig({ APPDATA: tempRoot }, fs);

  assert.equal(config.apiVersion, "2025-03-01-preview");
  assert.equal(config.transcribeDeployment, "whisper");
  assert.equal(config.polishDeployment, "gpt-4o");
});

test("readAzureOpenAiConfig falls back to the legacy apiKey/openaiApiKey fields", async () => {
  const tempRoot = await writeConfig({
    azureEndpoint: "https://example.cognitiveservices.azure.com/",
    openaiApiKey: "legacy-key",
  });

  const config = await readAzureOpenAiConfig({ APPDATA: tempRoot }, fs);

  assert.equal(config.apiKey, "legacy-key");
});

test("readAzureOpenAiConfig throws when the endpoint is missing", async () => {
  const tempRoot = await writeConfig({ azureApiKey: "azure-key" });

  await assert.rejects(
    readAzureOpenAiConfig({ APPDATA: tempRoot }, fs),
    /azureEndpoint/,
  );
});

test("readMuteSystemAudioWhileRecording defaults to enabled", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  const shouldMute = await readMuteSystemAudioWhileRecording({ APPDATA: tempRoot }, fs);

  assert.equal(shouldMute, true);
});

test("readMuteSystemAudioWhileRecording allows config opt-out", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key", muteSystemAudioWhileRecording: false }),
    "utf8",
  );

  const shouldMute = await readMuteSystemAudioWhileRecording({ APPDATA: tempRoot }, fs);

  assert.equal(shouldMute, false);
});

test("readFocusOnDeliver defaults to disabled — never steal focus unless opted in", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  const shouldFocus = await readFocusOnDeliver({ APPDATA: tempRoot }, fs);

  assert.equal(shouldFocus, false);
});

test("readFocusOnDeliver allows explicit opt-in", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key", focusOnDeliver: true }),
    "utf8",
  );

  const shouldFocus = await readFocusOnDeliver({ APPDATA: tempRoot }, fs);

  assert.equal(shouldFocus, true);
});

test("writeOverlayPosition persists the overlay position without dropping existing config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  const configPath = path.join(configDir, "config.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ openaiApiKey: "test-api-key" }), "utf8");

  await writeOverlayPosition({ x: 321, y: 654 }, { APPDATA: tempRoot }, fs);

  assert.deepEqual(await readOverlayPosition({ APPDATA: tempRoot }, fs), { x: 321, y: 654 });
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).openaiApiKey, "test-api-key");
});

test("readVocabularyConfig returns null when vocabulary is absent", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  const vocab = await readVocabularyConfig({ APPDATA: tempRoot }, fs);

  assert.equal(vocab, null);
});

test("readVocabularyConfig returns null when enabled is false", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({
      openaiApiKey: "test-api-key",
      vocabulary: { enabled: false, terms: ["ProjectZephyr"] },
    }),
    "utf8",
  );

  const vocab = await readVocabularyConfig({ APPDATA: tempRoot }, fs);

  assert.equal(vocab, null);
});

test("readVocabularyConfig normalizes terms, phrases, and replacements", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({
      openaiApiKey: "test-api-key",
      vocabulary: {
        terms: ["ProjectZephyr", "  ExampleCorp  ", "", "ProjectZephyr", 42],
        phrases: ["agent memory service"],
        replacements: [
          { wrong: "mister flow", right: "Mistr Flow" },
          { wrong: "", right: "ignored" },
          { wrong: "clod code", right: "Claude Code" },
        ],
      },
    }),
    "utf8",
  );

  const vocab = await readVocabularyConfig({ APPDATA: tempRoot }, fs);

  assert.deepEqual(vocab?.terms, ["ProjectZephyr", "ExampleCorp"]);
  assert.deepEqual(vocab?.phrases, ["agent memory service"]);
  assert.deepEqual(vocab?.replacements, [
    { wrong: "mister flow", right: "Mistr Flow" },
    { wrong: "clod code", right: "Claude Code" },
  ]);
});

test("readVocabularyConfig returns null when config file does not exist", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));

  const vocab = await readVocabularyConfig({ APPDATA: tempRoot }, fs);

  assert.equal(vocab, null);
});

test("writeOverlayPosition tolerates a transient empty config file while dragging", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  const configPath = path.join(configDir, "config.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, "", "utf8");

  await writeOverlayPosition({ x: 111, y: 222 }, { APPDATA: tempRoot }, fs);

  assert.deepEqual(await readOverlayPosition({ APPDATA: tempRoot }, fs), { x: 111, y: 222 });
});
