import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getConfigPath,
  readFocusOnDeliver,
  readCopySelectionFirst,
  readMuteSystemAudioWhileRecording,
  readDoneChime,
  readPersistentBlockDing,
  readOpenAiApiKey,
  readOverlayPosition,
  readProvider,
  readVocabularyConfig,
  writeOverlayPosition,
} from "../src/config";

test("getConfigPath resolves the Windows config location from APPDATA", () => {
  const configPath = getConfigPath({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" });

  assert.equal(
    configPath,
    path.join("C:\\Users\\alice\\AppData\\Roaming", "MistrFlow", "config.json"),
  );
});

test("readOpenAiApiKey reads the runtime config file", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  const apiKey = await readOpenAiApiKey({ APPDATA: tempRoot }, fs);

  assert.equal(apiKey, "test-api-key");
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

test("readPersistentBlockDing defaults to enabled — the one nudge is on unless silenced", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  const shouldDing = await readPersistentBlockDing({ APPDATA: tempRoot }, fs);

  assert.equal(shouldDing, true);
});

test("readPersistentBlockDing allows config opt-out — keep the visual, kill the sound", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key", persistentBlockDing: false }),
    "utf8",
  );

  const shouldDing = await readPersistentBlockDing({ APPDATA: tempRoot }, fs);

  assert.equal(shouldDing, false);
});

test("readDoneChime defaults to enabled — the soft chime is on unless silenced", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  const shouldChime = await readDoneChime({ APPDATA: tempRoot }, fs);

  assert.equal(shouldChime, true);
});

test("readDoneChime allows config opt-out — keep the badge and jump, kill the sound", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key", doneChime: false }),
    "utf8",
  );

  const shouldChime = await readDoneChime({ APPDATA: tempRoot }, fs);

  assert.equal(shouldChime, false);
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

test("readCopySelectionFirst defaults to disabled — read the existing clipboard", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  assert.equal(await readCopySelectionFirst({ APPDATA: tempRoot }, fs), false);
});

test("readCopySelectionFirst allows explicit opt-in", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key", copySelectionFirst: true }),
    "utf8",
  );

  assert.equal(await readCopySelectionFirst({ APPDATA: tempRoot }, fs), true);
});

test("readProvider defaults to openai when the field is absent", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key" }),
    "utf8",
  );

  const provider = await readProvider({ APPDATA: tempRoot }, fs);

  assert.equal(provider, "openai");
});

test("readProvider returns the configured provider", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ openaiApiKey: "test-api-key", provider: "azure" }),
    "utf8",
  );

  const provider = await readProvider({ APPDATA: tempRoot }, fs);

  assert.equal(provider, "azure");
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
