import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProjectAnchors,
  resolveProjectAnchor,
  type ProjectAnchor,
} from "../src/projectAnchors";

// ---------------------------------------------------------------------------
// normalizeProjectAnchors — config validation
// ---------------------------------------------------------------------------

test("normalizeProjectAnchors keeps well-formed entries and drops junk without throwing", () => {
  const anchors = normalizeProjectAnchors([
    { prefix: "C:\\dev\\mistr-flow", name: "Mistr Flow", glyph: "tophat" },
    { prefix: "", name: "Empty prefix", glyph: "note" },
    { prefix: "C:\\dev\\x", name: "", glyph: "note" },
    { prefix: "C:\\dev\\y", name: "No glyph", glyph: "" },
    "not an object",
    null,
    { prefix: 42, name: "Wrong types", glyph: "note" },
  ]);

  assert.deepEqual(anchors, [
    { prefix: "C:\\dev\\mistr-flow", name: "Mistr Flow", glyph: "tophat" },
  ]);
});

test("normalizeProjectAnchors returns empty for a non-array and dedupes equivalent prefixes", () => {
  assert.deepEqual(normalizeProjectAnchors(undefined), []);
  assert.deepEqual(normalizeProjectAnchors({ prefix: "x" }), []);

  const deduped = normalizeProjectAnchors([
    { prefix: "C:\\dev\\mistr-flow", name: "First", glyph: "tophat" },
    { prefix: "c:/dev/mistr-flow/", name: "Same path, different spelling", glyph: "note" },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].name, "First");
});

// ---------------------------------------------------------------------------
// resolveProjectAnchor — longest-prefix path matching
// ---------------------------------------------------------------------------

const ANCHORS: ProjectAnchor[] = [
  { prefix: "C:\\dev\\mistr-flow", name: "Mistr Flow", glyph: "tophat" },
  { prefix: "C:\\dev\\hermes", name: "Hermes", glyph: "wing" },
  { prefix: "C:\\dev\\hermes\\scratch", name: "Hermes Scratch", glyph: "flask" },
];

test("resolveProjectAnchor matches exact paths and subfolders", () => {
  assert.equal(resolveProjectAnchor("C:\\dev\\mistr-flow", ANCHORS)?.name, "Mistr Flow");
  assert.equal(
    resolveProjectAnchor("C:\\dev\\mistr-flow\\src\\deep", ANCHORS)?.name,
    "Mistr Flow",
  );
});

test("resolveProjectAnchor is case-insensitive and separator-agnostic", () => {
  assert.equal(resolveProjectAnchor("c:/DEV/Mistr-Flow/tui", ANCHORS)?.name, "Mistr Flow");
});

test("resolveProjectAnchor honors path boundaries — a prefix never claims its sibling", () => {
  // C:\dev\hermes must not claim C:\dev\hermes-2, and C:\dev\mistr must not
  // claim C:\dev\mistr-flow: matching is at a separator, not raw startsWith.
  assert.equal(resolveProjectAnchor("C:\\dev\\hermes-2", ANCHORS), null);
  assert.equal(
    resolveProjectAnchor("C:\\dev\\mistr", [
      { prefix: "C:\\dev\\mistr-flow", name: "Mistr Flow", glyph: "tophat" },
    ]),
    null,
  );
});

test("resolveProjectAnchor picks the longest matching prefix, so nested anchors coexist", () => {
  assert.equal(resolveProjectAnchor("C:\\dev\\hermes\\src", ANCHORS)?.name, "Hermes");
  assert.equal(
    resolveProjectAnchor("C:\\dev\\hermes\\scratch\\idea-7", ANCHORS)?.name,
    "Hermes Scratch",
  );
});

test("resolveProjectAnchor returns null for a null cwd or an empty anchor list", () => {
  assert.equal(resolveProjectAnchor(null, ANCHORS), null);
  assert.equal(resolveProjectAnchor(undefined, ANCHORS), null);
  assert.equal(resolveProjectAnchor("C:\\dev\\mistr-flow", []), null);
});
