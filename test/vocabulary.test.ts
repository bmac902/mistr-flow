import assert from "node:assert/strict";
import test from "node:test";

import type { VocabularyConfig } from "../src/config";
import {
  buildPolishVocabularyInstruction,
  buildWhisperVocabularyPrompt,
} from "../src/vocabulary";

const EMPTY: VocabularyConfig = { terms: [], phrases: [], replacements: [] };

test("buildWhisperVocabularyPrompt returns null for null vocabulary", () => {
  assert.equal(buildWhisperVocabularyPrompt(null), null);
});

test("buildWhisperVocabularyPrompt returns null for empty vocabulary", () => {
  assert.equal(buildWhisperVocabularyPrompt(EMPTY), null);
});

test("buildWhisperVocabularyPrompt includes terms and phrases", () => {
  const vocab: VocabularyConfig = {
    terms: ["ProjectZephyr", "ExampleCorp"],
    phrases: ["agent memory service"],
    replacements: [],
  };
  const prompt = buildWhisperVocabularyPrompt(vocab);
  assert.ok(prompt?.includes("ProjectZephyr"), "should include term");
  assert.ok(prompt?.includes("ExampleCorp"), "should include term");
  assert.ok(prompt?.includes("agent memory service"), "should include phrase");
});

test("buildWhisperVocabularyPrompt returns null when only replacements are present", () => {
  const vocab: VocabularyConfig = {
    terms: [],
    phrases: [],
    replacements: [{ wrong: "mister flow", right: "Mistr Flow" }],
  };
  assert.equal(buildWhisperVocabularyPrompt(vocab), null);
});

test("buildWhisperVocabularyPrompt does not include replacement wrong values", () => {
  const vocab: VocabularyConfig = {
    terms: ["ExampleCorp"],
    phrases: [],
    replacements: [{ wrong: "mister flow", right: "Mistr Flow" }],
  };
  const prompt = buildWhisperVocabularyPrompt(vocab);
  assert.ok(!prompt?.includes("mister flow"), "should not include wrong-side of replacement");
});

test("buildPolishVocabularyInstruction returns null for null vocabulary", () => {
  assert.equal(buildPolishVocabularyInstruction(null), null);
});

test("buildPolishVocabularyInstruction returns null for empty vocabulary", () => {
  assert.equal(buildPolishVocabularyInstruction(EMPTY), null);
});

test("buildPolishVocabularyInstruction includes terms, phrases, and replacements", () => {
  const vocab: VocabularyConfig = {
    terms: ["ProjectZephyr"],
    phrases: ["agent memory service"],
    replacements: [{ wrong: "mister flow", right: "Mistr Flow" }],
  };
  const instruction = buildPolishVocabularyInstruction(vocab);
  assert.ok(instruction?.includes("ProjectZephyr"), "should include term");
  assert.ok(instruction?.includes("agent memory service"), "should include phrase");
  assert.ok(instruction?.includes("mister flow"), "should include wrong value");
  assert.ok(instruction?.includes("Mistr Flow"), "should include right value");
});

test("buildPolishVocabularyInstruction works with replacements only", () => {
  const vocab: VocabularyConfig = {
    terms: [],
    phrases: [],
    replacements: [{ wrong: "clod code", right: "Claude Code" }],
  };
  const instruction = buildPolishVocabularyInstruction(vocab);
  assert.ok(instruction?.includes("clod code"), "should include wrong value");
  assert.ok(instruction?.includes("Claude Code"), "should include right value");
});

test("buildPolishVocabularyInstruction includes safety constraint", () => {
  const vocab: VocabularyConfig = {
    terms: ["ProjectZephyr"],
    phrases: [],
    replacements: [],
  };
  const instruction = buildPolishVocabularyInstruction(vocab);
  assert.ok(
    instruction?.toLowerCase().includes("do not introduce"),
    "should forbid introducing unspoken terms",
  );
});
