import assert from "node:assert/strict";
import test from "node:test";

import { toPipePath } from "../src/herdrSocket";
import { raiseHerdrWindow } from "../src/herdrWindow";

// NOTE ON WHAT THESE TESTS ARE FOR.
// They cover this module's own orchestration contract — ordering, title
// restoration, and the rule that nothing here may escalate into a delivery
// failure. They deliberately do NOT re-assert Herdr's socket schema: a mocked
// re-statement of an external contract is what made #27 pass its suite while
// being wrong about every single field. The real socket/Win32 behaviour is
// proven by running it live (see docs/adr/0002 for the recorded evidence).

interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function makeSocket(responses: Record<string, unknown | undefined>) {
  const calls: Call[] = [];
  const connect = () => {
    throw new Error("connect must not be reached: socketDeps is stubbed per-call");
  };
  return { calls, connect, responses };
}

/**
 * raiseHerdrWindow talks to the socket via callHerdrSocket, so we stub at the
 * `connect` seam with a fake in-memory pipe that speaks the real newline-JSON
 * framing (request echoed by id).
 */
function fakeConnectFactory(
  calls: Call[],
  reply: (method: string) => Record<string, unknown> | null,
) {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  return () => {
    const socket = new EventEmitter() as any;
    socket.write = (line: string) => {
      const msg = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      calls.push({ method: msg.method, params: msg.params });
      const result = reply(msg.method);
      setImmediate(() => {
        if (result === null) {
          socket.emit("error", new Error("EPIPE"));
          return;
        }
        socket.emit("data", Buffer.from(JSON.stringify({ id: msg.id, result }) + "\n"));
      });
      return true;
    };
    socket.destroy = () => {};
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
}

test("toPipePath names the Windows pipe after the socket path verbatim", () => {
  assert.equal(
    toPipePath("C:\\Users\\blair\\AppData\\Roaming\\herdr\\herdr.sock"),
    "\\\\.\\pipe\\C:\\Users\\blair\\AppData\\Roaming\\herdr\\herdr.sock",
  );
});

test("skips without touching the socket when herdr reports no socket path", async () => {
  let connected = false;
  const outcome = await raiseHerdrWindow({
    socketPath: null,
    socketDeps: { connect: (() => { connected = true; throw new Error("nope"); }) as never },
  });
  assert.deepEqual(outcome, { kind: "skipped", code: "socket-path-unknown" });
  assert.equal(connected, false);
});

test("raises the window and always restores the title afterwards", async () => {
  const calls: Call[] = [];
  const execCalls: string[][] = [];
  const outcome = await raiseHerdrWindow({
    socketPath: "S",
    mintNonce: () => "abcd1234",
    scriptPath: "focus.ps1",
    socketDeps: {
      connect: fakeConnectFactory(calls, (m) =>
        m === "client.window_title.set"
          ? { type: "client_window_title", changed: true, reason: "set" }
          : { type: "client_window_title", changed: true, reason: "cleared" },
      ) as never,
      delay: async () => {},
    },
    execFile: (file, args, cb) => {
      execCalls.push([file, ...args]);
      cb(null, "67290\n", "");
    },
  });

  assert.deepEqual(outcome, { kind: "raised", hwnd: "67290" });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["client.window_title.set", "client.window_title.clear"],
    "title must be set before the helper runs and cleared after",
  );
  // The nonce the helper is told to find must be the exact title we set.
  assert.equal(calls[0].params.title, "herdr - mistr flow abcd1234");
  assert.ok(execCalls[0].includes("herdr - mistr flow abcd1234"));
  assert.equal(execCalls[0][0], "powershell");
});

test("restores the title even when the focus helper fails", async () => {
  const calls: Call[] = [];
  const outcome = await raiseHerdrWindow({
    socketPath: "S",
    socketDeps: {
      connect: fakeConnectFactory(calls, () => ({ changed: true })) as never,
      delay: async () => {},
    },
    execFile: (_file, _args, cb) => {
      const error = Object.assign(new Error("no match"), { code: 3 });
      cb(error, "", "");
    },
  });

  assert.deepEqual(outcome, { kind: "skipped", code: "window-not-found" });
  assert.ok(
    calls.some((c) => c.method === "client.window_title.clear"),
    "a failed raise must not leave the sentinel title on the user's window",
  );
});

test("maps helper exit codes and spawn failures to distinct skip reasons", async () => {
  const cases: Array<[string | number, string]> = [
    [4, "foreground-refused"],
    [1, "helper-error"],
    ["ENOENT", "helper-not-found"],
  ];
  for (const [code, expected] of cases) {
    const calls: Call[] = [];
    const outcome = await raiseHerdrWindow({
      socketPath: "S",
      socketDeps: {
        connect: fakeConnectFactory(calls, () => ({ changed: true })) as never,
        delay: async () => {},
      },
      execFile: (_f, _a, cb) => cb(Object.assign(new Error("x"), { code }), "", ""),
    });
    assert.deepEqual(outcome, { kind: "skipped", code: expected });
  }
});

test("skips when herdr has no attached client to own a window", async () => {
  const calls: Call[] = [];
  let helperRan = false;
  const outcome = await raiseHerdrWindow({
    socketPath: "S",
    socketDeps: {
      connect: fakeConnectFactory(calls, () => ({
        type: "client_window_title",
        changed: false,
        reason: "no_foreground_client",
      })) as never,
      delay: async () => {},
    },
    execFile: () => {
      helperRan = true;
    },
  });
  assert.deepEqual(outcome, { kind: "skipped", code: "no-foreground-client" });
  assert.equal(helperRan, false, "no window exists, so the helper must not run");
});

test("retries the socket, because herdr's first connect after idle is a dead pipe", async () => {
  // Reproduces the real quirk: attempt #1 EPIPEs, #2 succeeds.
  const calls: Call[] = [];
  let attempt = 0;
  const outcome = await raiseHerdrWindow({
    socketPath: "S",
    socketDeps: {
      connect: fakeConnectFactory(calls, () => {
        attempt += 1;
        return attempt === 1 ? null : { changed: true };
      }) as never,
      delay: async () => {},
    },
    execFile: (_f, _a, cb) => cb(null, "67290", ""),
  });
  assert.equal(outcome.kind, "raised");
});
