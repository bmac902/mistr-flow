import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getConfigPath, readOpenAiApiKey } from "../src/config";

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

  const apiKey = await readOpenAiApiKey(
    { APPDATA: tempRoot },
    fs,
  );

  assert.equal(apiKey, "test-api-key");
});
