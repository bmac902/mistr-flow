import assert from "node:assert/strict";
import test from "node:test";

import {
  DONE_CHIME_BEEP,
  createHerdrForegroundCheck,
  playDoneChime,
  shouldChimeDone,
} from "../src/doneChime";
import { createFleetState } from "../src/fleetState";
import type { WatchedAgent } from "../src/herdr";

function agent(target: string, status: WatchedAgent["status"]): WatchedAgent {
  return { target, agent: target, status };
}

// --- the pure gate ---------------------------------------------------------

const CHIME: Parameters<typeof shouldChimeDone>[0] = {
  newlyDoneTargets: ["a"],
  chimeEnabled: true,
  verbActive: false,
  herdrForeground: false,
};

test("a new done episode with Herdr not foreground chimes", () => {
  assert.equal(shouldChimeDone(CHIME), true);
});

test("no newly-done target never chimes", () => {
  assert.equal(shouldChimeDone({ ...CHIME, newlyDoneTargets: [] }), false);
});

test("Herdr foreground at the transition consumes the chime", () => {
  assert.equal(shouldChimeDone({ ...CHIME, herdrForeground: true }), false);
});

test("doneChime disabled silences the chime", () => {
  assert.equal(shouldChimeDone({ ...CHIME, chimeEnabled: false }), false);
});

test("an active verb suppresses the chime", () => {
  assert.equal(shouldChimeDone({ ...CHIME, verbActive: true }), false);
});

// --- consume-on-suppress across an episode (gate + fleetState) -------------

// The one-shot lives in fleetState; the gate only decides at the transition
// poll. These prove the episode-level contracts the chime rides on.
test("Herdr foreground at the transition consumes the chime for the whole episode", () => {
  const fleet = createFleetState();

  // Transition poll: newly done, but Herdr is foreground → consumed.
  let posture = fleet.observe({ kind: "panes", agents: [agent("a", "done")] }, 0);
  assert.deepEqual(posture.newlyDoneTargets, ["a"]);
  assert.equal(
    shouldChimeDone({
      newlyDoneTargets: posture.newlyDoneTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: true, // looking at Herdr at the moment of completion
    }),
    false,
  );

  // Later poll, same episode, now NOT foreground: the one-shot is spent, so the
  // gate has nothing to fire — the chime is never deferred to a later alt-tab.
  posture = fleet.observe({ kind: "panes", agents: [agent("a", "done")] }, 5000);
  assert.deepEqual(posture.newlyDoneTargets, []);
  assert.equal(
    shouldChimeDone({
      newlyDoneTargets: posture.newlyDoneTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    false,
  );
});

test("a new episode with Herdr not foreground chimes exactly once, not on later polls", () => {
  const fleet = createFleetState();

  let posture = fleet.observe({ kind: "panes", agents: [agent("a", "done")] }, 0);
  assert.equal(
    shouldChimeDone({
      newlyDoneTargets: posture.newlyDoneTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    true,
  );

  posture = fleet.observe({ kind: "panes", agents: [agent("a", "done")] }, 5000);
  assert.equal(
    shouldChimeDone({
      newlyDoneTargets: posture.newlyDoneTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    false,
  );
});

// --- the chime is audibly distinct from the ding --------------------------

test("the chime's beep parameters differ from the persistent-block ding (900,120)", () => {
  // The ding is [console]::beep(900,120); the chime must be gentler — lower.
  assert.notEqual(DONE_CHIME_BEEP.hz, 900);
  assert.ok(DONE_CHIME_BEEP.hz < 900, "chime is a lower, gentler tone than the ding");
});

test("playDoneChime shells out with its own lower beep parameters", () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  playDoneChime((file, args, cb) => {
    calls.push({ file, args });
    cb(null, "", "");
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell");
  const command = calls[0].args.join(" ");
  assert.ok(
    command.includes(`[console]::beep(${DONE_CHIME_BEEP.hz},${DONE_CHIME_BEEP.ms})`),
    "chime command carries the done-chime parameters",
  );
  assert.ok(!command.includes("beep(900,120)"), "not the ding's parameters");
});

// --- the injectable foreground seam ---------------------------------------

// A fake execFile that resolves the two helper scripts by name. The find helper
// returns a stable HWND; the foreground helper answers by exit code.
function fakeExec(opts: {
  findHwnd: string | null;
  foreground: () => "foreground" | "not-foreground" | "stale";
  onFind?: () => void;
}) {
  return (
    file: string,
    args: readonly string[],
    cb: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
  ): void => {
    const joined = args.join(" ");
    if (joined.includes("find-window-by-title")) {
      opts.onFind?.();
      if (opts.findHwnd === null) {
        cb(Object.assign(new Error("not found"), { code: 3 }), "", "");
      } else {
        cb(null, opts.findHwnd + "\n", "");
      }
      return;
    }
    if (joined.includes("is-window-foreground")) {
      const state = opts.foreground();
      if (state === "foreground") cb(null, "", "");
      else if (state === "stale") cb(Object.assign(new Error("gone"), { code: 3 }), "", "");
      else cb(Object.assign(new Error("bg"), { code: 10 }), "", "");
      return;
    }
    cb(Object.assign(new Error("unexpected"), { code: 1 }), "", "");
  };
}

// Stub the socket at the real `connect` seam (mirrors herdrWindow.test): a fake
// in-memory pipe that answers window_title.set/clear with `changed: true`.
function okConnect() {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  return () => {
    const socket = new EventEmitter() as any;
    socket.write = (line: string) => {
      const msg = JSON.parse(line) as { id: string };
      setImmediate(() =>
        socket.emit("data", Buffer.from(JSON.stringify({ id: msg.id, result: { changed: true } }) + "\n")),
      );
      return true;
    };
    socket.destroy = () => {};
    setImmediate(() => socket.emit("connect"));
    return socket;
  };
}
const okSocket = { connect: okConnect(), delay: async () => {} };

test("the foreground check identifies Herdr's window once and caches the handle", async () => {
  let finds = 0;
  const check = createHerdrForegroundCheck({
    socketPath: "/tmp/herdr.sock",
    mintNonce: () => "nonce",
    socketDeps: okSocket as never,
    execFile: fakeExec({
      findHwnd: "12345",
      foreground: () => "foreground",
      onFind: () => finds++,
    }),
  });

  assert.equal(await check(), true);
  assert.equal(await check(), true);
  // Identified once, then the cheap foreground compare rides the cached handle.
  assert.equal(finds, 1);
});

test("the foreground check re-identifies when the cached window has gone stale", async () => {
  let finds = 0;
  let stale = true;
  const check = createHerdrForegroundCheck({
    socketPath: "/tmp/herdr.sock",
    mintNonce: () => "nonce",
    socketDeps: okSocket as never,
    execFile: fakeExec({
      findHwnd: "999",
      // First compare reports the handle vanished; after re-identify it's foreground.
      foreground: () => {
        if (stale) {
          stale = false;
          return "stale";
        }
        return "foreground";
      },
      onFind: () => finds++,
    }),
  });

  assert.equal(await check(), true);
  // Once to identify, once more after the staleness signal.
  assert.equal(finds, 2);
});

test("the foreground check reports not-foreground when Herdr's window can't be found", async () => {
  const check = createHerdrForegroundCheck({
    socketPath: "/tmp/herdr.sock",
    mintNonce: () => "nonce",
    socketDeps: okSocket as never,
    execFile: fakeExec({ findHwnd: null, foreground: () => "not-foreground" }),
  });

  // Can't see Herdr at all → definitely not looking at it → not foreground.
  assert.equal(await check(), false);
});
