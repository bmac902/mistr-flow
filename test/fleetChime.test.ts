import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKED_CHIME,
  DONE_CHIME,
  chimeCommand,
  createHerdrForegroundCheck,
  playBlockedChime,
  playDoneChime,
  shouldChime,
} from "../src/fleetChime";
import { createFleetState } from "../src/fleetState";
import type { WatchedAgent } from "../src/herdr";

function agent(target: string, status: WatchedAgent["status"]): WatchedAgent {
  return { target, agent: target, status };
}

/** Capture the PowerShell command a play* helper shells out with. */
function commandFrom(play: (execFile: never) => void): string {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  play(((file: string, args: readonly string[], cb: (...a: unknown[]) => void) => {
    calls.push({ file, args });
    cb(null, "", "");
  }) as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell");
  return calls[0].args.join(" ");
}

// --- the pure gate, shared by both cues ------------------------------------

const CHIME: Parameters<typeof shouldChime>[0] = {
  newlyTargets: ["a"],
  chimeEnabled: true,
  verbActive: false,
  herdrForeground: false,
};

test("a new episode with Herdr not foreground chimes", () => {
  assert.equal(shouldChime(CHIME), true);
});

test("no newly-signalled target never chimes", () => {
  assert.equal(shouldChime({ ...CHIME, newlyTargets: [] }), false);
});

test("Herdr foreground at the transition consumes the chime", () => {
  assert.equal(shouldChime({ ...CHIME, herdrForeground: true }), false);
});

test("a disabled cue is silenced", () => {
  assert.equal(shouldChime({ ...CHIME, chimeEnabled: false }), false);
});

test("an active verb suppresses the chime", () => {
  assert.equal(shouldChime({ ...CHIME, verbActive: true }), false);
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
    shouldChime({
      newlyTargets: posture.newlyDoneTargets,
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
    shouldChime({
      newlyTargets: posture.newlyDoneTargets,
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
    shouldChime({
      newlyTargets: posture.newlyDoneTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    true,
  );

  posture = fleet.observe({ kind: "panes", agents: [agent("a", "done")] }, 5000);
  assert.equal(
    shouldChime({
      newlyTargets: posture.newlyDoneTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    false,
  );
});

// --- the two cues are audibly distinct ------------------------------------

// There is no audio in CI (nor in the Sandcastle sandbox), so every claim about
// the SOUND is asserted against the PowerShell command we shell out with. That
// pins the rhythm — the property the design actually rests on — without ears.

test("done is a single soft tone; blocked is a double beep", () => {
  assert.equal(DONE_CHIME.tones.length, 1, "done is one tone");
  assert.equal(BLOCKED_CHIME.tones.length, 2, "blocked is two");
  // Rhythm carries the meaning, but blocked stays the higher, more urgent pitch.
  assert.ok(DONE_CHIME.tones[0].hz < BLOCKED_CHIME.tones[0].hz);
});

test("a multi-tone chime separates its beeps with a real sleep", () => {
  // Without the gap, back-to-back [console]::beep calls render as ONE tone and
  // the whole done/blocked distinction collapses.
  const command = chimeCommand(BLOCKED_CHIME);
  assert.ok(
    command.includes(`Start-Sleep -Milliseconds ${BLOCKED_CHIME.gapMs}`),
    "blocked's beeps are separated by a sleep",
  );
  assert.ok(BLOCKED_CHIME.gapMs > 0);
});

test("a single-tone chime emits no sleep at all", () => {
  assert.ok(!chimeCommand(DONE_CHIME).includes("Start-Sleep"));
});

test("playDoneChime shells out with exactly one beep, at the done parameters", () => {
  const command = commandFrom(playDoneChime);
  assert.ok(command.includes("[console]::beep(587,90)"), "carries the done parameters");
  assert.equal(command.match(/\[console\]::beep/g)?.length, 1, "exactly one beep");
});

test("playBlockedChime shells out with two 900Hz beeps around a sleep", () => {
  const command = commandFrom(playBlockedChime);
  assert.equal(command.match(/\[console\]::beep\(900,70\)/g)?.length, 2);
  assert.ok(command.includes("Start-Sleep -Milliseconds 60"));
});

test("the two chime commands are distinct, blocked carrying strictly more beeps", () => {
  const done = commandFrom(playDoneChime);
  const blocked = commandFrom(playBlockedChime);
  assert.notEqual(done, blocked);

  const beeps = (command: string) => command.match(/\[console\]::beep/g)?.length ?? 0;
  assert.ok(beeps(blocked) > beeps(done), "blocked is the busier rhythm");
});

// --- blocked rides the same gate as done ----------------------------------

test("a block announces at the dwell crossing and chimes exactly once", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  // Inside the dwell: nothing to chime — the transient-self-block filter.
  let posture = fleet.observe({ kind: "panes", agents: [agent("a", "blocked")] }, 0);
  assert.equal(
    shouldChime({
      newlyTargets: posture.newlyBlockedTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    false,
  );

  // The dwell crossing is the cue.
  posture = fleet.observe({ kind: "panes", agents: [agent("a", "blocked")] }, 5000);
  assert.equal(
    shouldChime({
      newlyTargets: posture.newlyBlockedTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    true,
  );

  // Still blocked much later — no second cue, no 4-minute escalation.
  posture = fleet.observe({ kind: "panes", agents: [agent("a", "blocked")] }, 300000);
  assert.equal(
    shouldChime({
      newlyTargets: posture.newlyBlockedTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    false,
  );
});

test("Herdr foreground at the dwell crossing consumes the blocked chime for the episode", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe({ kind: "panes", agents: [agent("a", "blocked")] }, 0);
  let posture = fleet.observe({ kind: "panes", agents: [agent("a", "blocked")] }, 5000);
  assert.deepEqual(posture.newlyBlockedTargets, ["a"]);
  assert.equal(
    shouldChime({
      newlyTargets: posture.newlyBlockedTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: true, // looking at Herdr as the block became real
    }),
    false,
  );

  // Later, same episode, now looking away: the one-shot is spent, so no
  // delayed surprise bell.
  posture = fleet.observe({ kind: "panes", agents: [agent("a", "blocked")] }, 20000);
  assert.deepEqual(posture.newlyBlockedTargets, []);
  assert.equal(
    shouldChime({
      newlyTargets: posture.newlyBlockedTargets,
      chimeEnabled: true,
      verbActive: false,
      herdrForeground: false,
    }),
    false,
  );
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
