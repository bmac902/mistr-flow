import assert from "node:assert/strict";
import test from "node:test";

import { attentionCycle, createBlockedJumpCursor } from "../src/blockedJumpCursor";
import type { FleetPosture } from "../src/fleetState";

function posture(
  blockedTargets: readonly string[],
  doneTargets: readonly string[] = [],
): FleetPosture {
  return {
    tier: blockedTargets.length === 0 ? "0" : "1",
    blockedCount: blockedTargets.length,
    longestBlockedTarget: blockedTargets[0] ?? null,
    blockedTargets,
    newlyPersistentBlockedTargets: [],
    doneCount: doneTargets.length,
    doneTargets,
    newlyDoneTargets: [],
  };
}

test("no blocked agents is a truthful no-op — null, and the cursor is unmoved", () => {
  const cursor = createBlockedJumpCursor();

  assert.equal(cursor.next([]), null);
  // A later population still starts from the oldest, unaffected by the no-op.
  assert.equal(cursor.next(["a", "b"]), "a");
});

test("the first press lands on the oldest-blocked agent (index 0)", () => {
  const cursor = createBlockedJumpCursor();

  assert.equal(cursor.next(["oldest", "middle", "newest"]), "oldest");
});

test("repeat presses cycle through the blocked agents, oldest first, then wrap", () => {
  const cursor = createBlockedJumpCursor();
  const blocked = ["a", "b", "c"];

  assert.equal(cursor.next(blocked), "a");
  assert.equal(cursor.next(blocked), "b");
  assert.equal(cursor.next(blocked), "c");
  // Wrap back to the oldest.
  assert.equal(cursor.next(blocked), "a");
});

test("a remembered target that has vanished is skipped — re-anchors to the oldest, never a dead pane", () => {
  const cursor = createBlockedJumpCursor();

  assert.equal(cursor.next(["a", "b", "c"]), "a");
  assert.equal(cursor.next(["a", "b", "c"]), "b"); // now sitting on 'b'
  // 'b' answered its block and left the set entirely.
  assert.equal(cursor.next(["a", "c"]), "a");
});

test("a newly-blocked agent appended to the set is reached by continued cycling", () => {
  const cursor = createBlockedJumpCursor();

  assert.equal(cursor.next(["a", "b"]), "a");
  assert.equal(cursor.next(["a", "b"]), "b");
  // 'c' blocks and dwells past threshold; it joins the tail.
  assert.equal(cursor.next(["a", "b", "c"]), "c");
  assert.equal(cursor.next(["a", "b", "c"]), "a");
});

test("the set emptying then repopulating restarts at the oldest", () => {
  const cursor = createBlockedJumpCursor();

  assert.equal(cursor.next(["a", "b"]), "a");
  assert.equal(cursor.next([]), null); // everything cleared
  assert.equal(cursor.next(["x", "y"]), "x"); // fresh episode, oldest first
});

test("attentionCycle: with anything blocked, the order is byte-identical to the blocked list", () => {
  // A bottleneck always outranks a harvest — blocked come first, unchanged.
  assert.deepEqual(attentionCycle(posture([])), []);
  assert.deepEqual(attentionCycle(posture(["a", "b"])), ["a", "b"]);
});

test("attentionCycle: blocked-first-then-done as one unified cycle", () => {
  assert.deepEqual(
    attentionCycle(posture(["blk1", "blk2"], ["dn1", "dn2"])),
    ["blk1", "blk2", "dn1", "dn2"],
  );
});

test("attentionCycle: with zero blocked, the cycle is the done list", () => {
  assert.deepEqual(attentionCycle(posture([], ["dn1", "dn2"])), ["dn1", "dn2"]);
});

test("gesture with zero blocked lands on the oldest done, repeats cycle the rest, wrapping", () => {
  const cursor = createBlockedJumpCursor();
  const cycle = attentionCycle(posture([], ["dn1", "dn2", "dn3"]));

  assert.equal(cursor.next(cycle), "dn1");
  assert.equal(cursor.next(cycle), "dn2");
  assert.equal(cursor.next(cycle), "dn3");
  assert.equal(cursor.next(cycle), "dn1"); // wrap
});

test("mixed fleet walks blocked oldest-first then done, as one gesture cycle", () => {
  const cursor = createBlockedJumpCursor();
  const cycle = attentionCycle(posture(["blk"], ["dn1", "dn2"]));

  assert.equal(cursor.next(cycle), "blk");
  assert.equal(cursor.next(cycle), "dn1");
  assert.equal(cursor.next(cycle), "dn2");
  assert.equal(cursor.next(cycle), "blk"); // wrap to the top of the unified cycle
});

test("a done target that vanished since the last poll is skipped, never jumped to", () => {
  const cursor = createBlockedJumpCursor();

  assert.equal(cursor.next(attentionCycle(posture([], ["dn1", "dn2"]))), "dn1");
  assert.equal(cursor.next(attentionCycle(posture([], ["dn1", "dn2"]))), "dn2");
  // 'dn2' was harvested (engaged) and left the done set — re-anchor to oldest.
  assert.equal(cursor.next(attentionCycle(posture([], ["dn1"]))), "dn1");
});
