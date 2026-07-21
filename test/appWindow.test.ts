import assert from "node:assert/strict";
import test from "node:test";

import { focusAppWindow, type AppWindowExecFile } from "../src/appWindow";
import type { AppTargetView } from "../src/appTargets";

const CHATGPT: AppTargetView = {
  label: "ChatGPT",
  process: "ChatGPT",
  title: null,
  glyph: "chatgpt",
  pasteFocusKeys: null,
  pasteDelayMs: null,
};

// NOTE: like herdrWindow.test.ts, these cover this module's OWN contract —
// exit-code mapping and argument shaping. The real Win32 focus behaviour is
// proven by running the helper live, not by a mocked re-statement of user32.

test("focused: success resolves the resolved HWND, and passes the process to the helper", async () => {
  const calls: string[][] = [];
  const execFile: AppWindowExecFile = (file, args, cb) => {
    calls.push([file, ...args]);
    cb(null, "31496\n", "");
  };
  const outcome = await focusAppWindow(CHATGPT, { execFile, scriptPath: "focus.ps1" });

  assert.deepEqual(outcome, { kind: "focused", hwnd: "31496" });
  assert.equal(calls[0][0], "powershell");
  assert.ok(calls[0].includes("-Process"));
  assert.ok(calls[0].includes("ChatGPT"));
  assert.ok(!calls[0].includes("-Title"), "no title passed when the view has none");
});

test("passes -Title as the fallback matcher when the view carries one", async () => {
  const calls: string[][] = [];
  const execFile: AppWindowExecFile = (_f, args, cb) => {
    calls.push([...args]);
    cb(null, "1", "");
  };
  await focusAppWindow(
    { ...CHATGPT, title: "ChatGPT" },
    { execFile, scriptPath: "focus.ps1" },
  );
  assert.ok(calls[0].includes("-Title"));
  assert.ok(calls[0].includes("ChatGPT"));
});

test("maps helper exit codes and spawn failures to distinct outcomes", async () => {
  const cases: Array<[string | number, string]> = [
    [3, "window-not-found"],
    [4, "foreground-refused"],
    ["ENOENT", "helper-not-found"],
    [1, "helper-error"],
  ];
  for (const [code, expected] of cases) {
    const execFile: AppWindowExecFile = (_f, _a, cb) =>
      cb(Object.assign(new Error("x"), { code }), "", "");
    const outcome = await focusAppWindow(CHATGPT, { execFile, scriptPath: "focus.ps1" });
    assert.equal(outcome.kind, expected);
  }
});

test("a match-less view is window-not-found without ever spawning the helper", async () => {
  let ran = false;
  const execFile: AppWindowExecFile = () => {
    ran = true;
  };
  const outcome = await focusAppWindow(
    { label: "Broken", process: null, title: null, glyph: null, pasteFocusKeys: null, pasteDelayMs: null },
    { execFile },
  );
  assert.deepEqual(outcome, { kind: "window-not-found" });
  assert.equal(ran, false);
});
