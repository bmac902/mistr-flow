import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getConfigPath,
  readOpenAiApiKey,
  readOverlayPosition,
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

test("writeOverlayPosition tolerates a transient empty config file while dragging", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mistr-flow-"));
  const configDir = path.join(tempRoot, "MistrFlow");
  const configPath = path.join(configDir, "config.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, "", "utf8");

  await writeOverlayPosition({ x: 111, y: 222 }, { APPDATA: tempRoot }, fs);

  assert.deepEqual(await readOverlayPosition({ APPDATA: tempRoot }, fs), { x: 111, y: 222 });
});
