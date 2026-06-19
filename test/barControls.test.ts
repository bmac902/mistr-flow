import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildBarContextMenu,
  openConfigFileWithDefaultHandler,
  runBarContextMenuAction,
} from "../src/barControls";

test("buildBarContextMenu exposes Quit and Open config file actions", () => {
  const menu = buildBarContextMenu();

  assert.deepEqual(menu.items, [
    { id: "quit", label: "Quit" },
    { id: "open-config-file", label: "Open config file" },
  ]);
});

test("runBarContextMenuAction quits through the provided dependency", async () => {
  const calls: string[] = [];

  await runBarContextMenuAction(
    "quit",
    {
      async quit() {
        calls.push("quit");
      },
      async openConfigFile() {
        calls.push("open");
      },
    },
  );

  assert.deepEqual(calls, ["quit"]);
});

test("runBarContextMenuAction opens the config file path from APPDATA", async () => {
  const calls: string[] = [];
  const env = { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" };

  await runBarContextMenuAction(
    "open-config-file",
    {
      async quit() {
        calls.push("quit");
      },
      async openConfigFile(configPath) {
        calls.push(configPath);
      },
    },
    env,
  );

  assert.deepEqual(calls, [
    path.join("C:\\Users\\alice\\AppData\\Roaming", "MistrFlow", "config.json"),
  ]);
});

test("openConfigFileWithDefaultHandler uses the OS default opener", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFile = (
    file: string,
    args: ReadonlyArray<string>,
    callback: (error: NodeJS.ErrnoException | null) => void,
  ) => {
    calls.push({ file, args: [...args] });
    callback(null);
  };

  await openConfigFileWithDefaultHandler(
    "C:\\Users\\alice\\AppData\\Roaming\\MistrFlow\\config.json",
    "win32",
    execFile,
  );

  await openConfigFileWithDefaultHandler(
    "/Users/alice/Library/Application Support/MistrFlow/config.json",
    "darwin",
    execFile,
  );

  await openConfigFileWithDefaultHandler(
    "/home/alice/.config/MistrFlow/config.json",
    "linux",
    execFile,
  );

  assert.deepEqual(calls, [
    {
      file: "cmd",
      args: ["/c", "start", "", "C:\\Users\\alice\\AppData\\Roaming\\MistrFlow\\config.json"],
    },
    {
      file: "open",
      args: ["/Users/alice/Library/Application Support/MistrFlow/config.json"],
    },
    {
      file: "xdg-open",
      args: ["/home/alice/.config/MistrFlow/config.json"],
    },
  ]);
});
