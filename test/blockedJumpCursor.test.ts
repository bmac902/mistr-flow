import assert from "node:assert/strict";
import test from "node:test";

import { createBlockedJumpCursor } from "../src/blockedJumpCursor";

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
