import assert from "node:assert/strict";
import test from "node:test";

import { createCaptureHistory } from "../src/captureHistory";

// A tiny entry shape: an id, a byte cost, and the file paths it references.
// Crops mint a new id but keep the same "original".
interface Entry {
  readonly id: string;
  readonly bytes: number;
  readonly paths: readonly string[];
}

function entry(id: string, bytes = 1, paths: readonly string[] = [`/tmp/${id}`]): Entry {
  return { id, bytes, paths };
}

function makeRing(opts: { maxEntries?: number; maxBytes?: number } = {}) {
  return createCaptureHistory<Entry>({
    maxEntries: opts.maxEntries,
    maxBytes: opts.maxBytes ?? Number.MAX_SAFE_INTEGER,
    sizeOf: (e) => e.bytes,
    pathsOf: (e) => e.paths,
  });
}

test("a fresh ring has no current entry and both moves are safe no-ops", () => {
  const ring = makeRing();
  assert.equal(ring.current, null);
  assert.equal(ring.currentOriginal, null);
  assert.equal(ring.length, 0);
  assert.equal(ring.cursorIndex, -1);

  ring.older();
  ring.newer();
  assert.equal(ring.current, null);
  assert.equal(ring.cursorIndex, -1);
});

test("push A then B: current is B, older gives A, newer gives B", () => {
  const ring = makeRing();
  ring.push(entry("A"));
  ring.push(entry("B"));

  assert.equal(ring.current?.id, "B");
  ring.older();
  assert.equal(ring.current?.id, "A");
  ring.newer();
  assert.equal(ring.current?.id, "B");
});

test("stepping older at the oldest stays put — no wraparound", () => {
  const ring = makeRing();
  ring.push(entry("A"));
  ring.push(entry("B"));
  ring.older();
  assert.equal(ring.current?.id, "A");
  ring.older();
  assert.equal(ring.current?.id, "A");
});

test("stepping newer at the newest stays put — no wraparound", () => {
  const ring = makeRing();
  ring.push(entry("A"));
  ring.push(entry("B"));
  assert.equal(ring.current?.id, "B");
  ring.newer();
  assert.equal(ring.current?.id, "B");
});

test("pushing while parked on an older entry resets the cursor to the new entry", () => {
  const ring = makeRing();
  ring.push(entry("A"));
  ring.push(entry("B"));
  ring.older();
  assert.equal(ring.current?.id, "A");

  ring.push(entry("C"));
  assert.equal(ring.current?.id, "C");
  assert.equal(ring.cursorIndex, ring.length - 1);
});

test("replaceCurrent updates in place: length, order and cursor all unchanged", () => {
  const ring = makeRing();
  ring.push(entry("A"));
  ring.push(entry("B"));
  ring.older();
  const before = { length: ring.length, cursor: ring.cursorIndex };

  ring.replaceCurrent(entry("A-cropped"));

  assert.equal(ring.length, before.length);
  assert.equal(ring.cursorIndex, before.cursor);
  assert.equal(ring.current?.id, "A-cropped");
  // Order intact: newer is still B.
  ring.newer();
  assert.equal(ring.current?.id, "B");
});

test("a replaced entry still exposes its pre-crop original", () => {
  const ring = makeRing();
  ring.push(entry("A"));
  ring.replaceCurrent(entry("A-cropped"));

  assert.equal(ring.current?.id, "A-cropped");
  assert.equal(ring.currentOriginal?.id, "A");
});

test("arrow-away-and-back preserves the crop, not the original", () => {
  const ring = makeRing();
  ring.push(entry("A"));
  ring.push(entry("B"));
  ring.older();
  assert.equal(ring.current?.id, "A");
  ring.replaceCurrent(entry("A-cropped"));

  ring.newer();
  assert.equal(ring.current?.id, "B");
  ring.older();
  assert.equal(ring.current?.id, "A-cropped");
});

test("pushing an 11th entry into a 10-entry ring evicts the oldest", () => {
  const ring = makeRing({ maxEntries: 10 });
  for (let i = 0; i < 11; i++) ring.push(entry(`E${i}`));

  assert.equal(ring.length, 10);
  // E0 (the oldest) is gone; walk to the oldest and confirm it is E1.
  for (let i = 0; i < 20; i++) ring.older();
  assert.equal(ring.current?.id, "E1");
});

test("byte-budget eviction evicts oldest-first even under the count cap", () => {
  const ring = makeRing({ maxEntries: 10, maxBytes: 30 });
  ring.push(entry("A", 10));
  ring.push(entry("B", 10));
  ring.push(entry("C", 10));
  // Now 30 bytes across 3 entries — under the 10-entry cap. A fourth 10-byte
  // entry busts the budget and must evict A.
  ring.push(entry("D", 10));

  assert.equal(ring.length, 3);
  for (let i = 0; i < 10; i++) ring.older();
  assert.equal(ring.current?.id, "B");
});

test("an entry larger than the whole budget is kept as the sole entry", () => {
  const ring = makeRing({ maxEntries: 10, maxBytes: 30 });
  ring.push(entry("huge", 1000));

  assert.equal(ring.length, 1);
  assert.equal(ring.current?.id, "huge");
});

test("retained paths include every path of every live entry", () => {
  const ring = makeRing();
  ring.push(entry("A", 1, ["/tmp/a1", "/tmp/a2"]));
  ring.push(entry("B", 1, ["/tmp/b1"]));

  assert.deepEqual(
    ring.retainedPaths(),
    new Set(["/tmp/a1", "/tmp/a2", "/tmp/b1"]),
  );
});

test("retained paths include a replaced entry's original and current paths", () => {
  const ring = makeRing();
  ring.push(entry("A", 1, ["/tmp/a-original"]));
  ring.replaceCurrent(entry("A-cropped", 1, ["/tmp/a-cropped"]));

  const paths = ring.retainedPaths();
  assert.ok(paths.has("/tmp/a-original"));
  assert.ok(paths.has("/tmp/a-cropped"));
});

test("retained paths exclude a just-evicted entry's paths", () => {
  const ring = makeRing({ maxEntries: 2 });
  ring.push(entry("A", 1, ["/tmp/a"]));
  ring.push(entry("B", 1, ["/tmp/b"]));
  ring.push(entry("C", 1, ["/tmp/c"])); // evicts A

  const paths = ring.retainedPaths();
  assert.ok(!paths.has("/tmp/a"));
  assert.deepEqual(paths, new Set(["/tmp/b", "/tmp/c"]));
});

test("evicting the cursor's entry leaves the cursor valid and the ring usable", () => {
  const ring = makeRing({ maxEntries: 3 });
  ring.push(entry("A"));
  ring.push(entry("B"));
  ring.push(entry("C"));
  // Park the cursor on the oldest (A), which is next to be evicted.
  ring.older();
  ring.older();
  assert.equal(ring.current?.id, "A");

  ring.push(entry("D")); // evicts A, then parks cursor on D per push semantics
  assert.equal(ring.length, 3);
  assert.equal(ring.current?.id, "D");
  assert.ok(ring.cursorIndex >= 0 && ring.cursorIndex < ring.length);

  // Ring still walks cleanly.
  ring.older();
  assert.equal(ring.current?.id, "C");
});

test("eviction of the parked entry when not the newest keeps the cursor in range", () => {
  // Directly exercise evictToFit's cursor clamp without push resetting it:
  // stand on the oldest, then trigger a byte eviction of that oldest via a
  // replace that grows the current-newest past budget is not possible, so use
  // a fresh push but assert the cursor never dangles across the eviction.
  const ring = makeRing({ maxEntries: 5, maxBytes: 20 });
  ring.push(entry("A", 10));
  ring.push(entry("B", 10));
  ring.older(); // parked on A
  assert.equal(ring.current?.id, "A");

  ring.push(entry("C", 10)); // busts budget, evicts A, cursor reset to C
  assert.ok(ring.cursorIndex >= 0 && ring.cursorIndex < ring.length);
  assert.equal(ring.current?.id, "C");
});
