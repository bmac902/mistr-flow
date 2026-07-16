import assert from "node:assert/strict";
import test from "node:test";

import { focusHerdrPane } from "../src/focusPane";
import type { HerdrWindowOutcome } from "../src/herdrWindow";

interface Call {
  readonly file: string;
  readonly args: readonly string[];
}

function recordingExecFile() {
  const calls: Call[] = [];
  let pending: ((error: (Error & { code?: string | number }) | null) => void) | null = null;
  return {
    calls,
    execFile(
      file: string,
      args: readonly string[],
      callback: (error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void,
    ) {
      calls.push({ file, args });
      pending = (error) => callback(error, "", error ? "boom" : "");
    },
    respond(error: (Error & { code?: string | number }) | null) {
      const cb = pending;
      pending = null;
      cb?.(error);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("focusHerdrPane focuses the pane, resolves the socket, then raises the window", async () => {
  const recorder = recordingExecFile();
  const raised: Array<{ socketPath: string | null }> = [];
  const outcome: HerdrWindowOutcome = { kind: "raised", hwnd: "0x99" };

  const promise = focusHerdrPane("term_A", {
    execFile: recorder.execFile,
    readSocketPath: async () => "/tmp/herdr.sock",
    raiseWindow: async (args) => {
      raised.push(args);
      return outcome;
    },
  });

  await flush();
  recorder.respond(null); // herdr agent focus succeeds
  const result = await promise;

  assert.deepEqual(recorder.calls, [
    { file: "herdr", args: ["agent", "focus", "term_A"] },
  ]);
  assert.deepEqual(raised, [{ socketPath: "/tmp/herdr.sock" }]);
  assert.deepEqual(result, { kind: "focused", raise: outcome });
});

test("focusHerdrPane never raises the window when the pane focus fails", async () => {
  const recorder = recordingExecFile();
  let raiseCalled = false;

  const promise = focusHerdrPane("term_A", {
    execFile: recorder.execFile,
    readSocketPath: async () => "/tmp/herdr.sock",
    raiseWindow: async () => {
      raiseCalled = true;
      return { kind: "raised", hwnd: "x" };
    },
  });

  await flush();
  recorder.respond(new Error("exit 1")); // herdr agent focus fails
  const result = await promise;

  assert.deepEqual(result, { kind: "focus-failed" });
  assert.equal(raiseCalled, false);
});
