import assert from "node:assert/strict";
import test from "node:test";

import {
  appTargetToEligibleTarget,
  normalizeAppTargets,
  type AppTarget,
} from "../src/appTargets";

// ---------------------------------------------------------------------------
// normalizeAppTargets — config validation
// ---------------------------------------------------------------------------

test("normalizeAppTargets keeps well-formed entries and drops junk without throwing", () => {
  const targets = normalizeAppTargets([
    { id: "chatgpt", label: "ChatGPT", process: "ChatGPT", glyph: "chatgpt" },
    { id: "slack", label: "Slack", title: "Slack" }, // title-only matcher is fine
    { id: "no-matcher", label: "No matcher" }, // neither process nor title → dropped
    { id: "", label: "Empty id", process: "X" }, // empty id → dropped
    { id: "no-label", label: "", process: "X" }, // empty label → dropped
    "not an object",
    null,
    { id: 42, label: "Wrong types", process: "X" }, // non-string id → dropped
  ]);

  assert.deepEqual(targets, [
    { id: "chatgpt", label: "ChatGPT", process: "ChatGPT", glyph: "chatgpt" },
    { id: "slack", label: "Slack", title: "Slack" },
  ]);
});

test("normalizeAppTargets returns empty for a non-array and dedupes by id", () => {
  assert.deepEqual(normalizeAppTargets(undefined), []);
  assert.deepEqual(normalizeAppTargets({ id: "x" }), []);

  const deduped = normalizeAppTargets([
    { id: "chatgpt", label: "First", process: "ChatGPT" },
    { id: "ChatGPT", label: "Same id, different case", process: "Other" },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].label, "First");
});

test("normalizeAppTargets sanitizes the id to a safe token and carries pasteFocusKeys", () => {
  const [target] = normalizeAppTargets([
    { id: "Chat GPT!!", label: "ChatGPT", process: "ChatGPT", pasteFocusKeys: "{ESC}" },
  ]);
  assert.equal(target.id, "chatgpt");
  assert.equal(target.pasteFocusKeys, "{ESC}");
});

test("normalizeAppTargets caps the list so a runaway config can't flood the picker", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `app${i}`,
    label: `App ${i}`,
    process: `Proc${i}`,
  }));
  assert.equal(normalizeAppTargets(many).length, 4);
});

// ---------------------------------------------------------------------------
// appTargetToEligibleTarget — projection into the picker's currency
// ---------------------------------------------------------------------------

test("appTargetToEligibleTarget mints an app-kind target with inert pane placeholders", () => {
  const app: AppTarget = {
    id: "chatgpt",
    label: "ChatGPT",
    process: "ChatGPT",
    glyph: "chatgpt",
    pasteFocusKeys: "{ESC}",
  };
  const target = appTargetToEligibleTarget(app);

  assert.equal(target.target, "app:chatgpt");
  assert.equal(target.label, "ChatGPT");
  assert.equal(target.kind, "app");
  // Inert pane placeholders — never read on the app path.
  assert.equal(target.agentStatus, "idle");
  assert.equal(target.agent, "chatgpt"); // absent from AGENT_CAP_COLORS ⇒ brass keycap
  assert.equal(target.cwd, null);
  // The matcher/presentation bag is total (null, not absent).
  assert.deepEqual(target.app, {
    label: "ChatGPT",
    process: "ChatGPT",
    title: null,
    glyph: "chatgpt",
    pasteFocusKeys: "{ESC}",
  });
});
