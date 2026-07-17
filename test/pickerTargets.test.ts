import assert from "node:assert/strict";
import test from "node:test";

import { appTargetToEligibleTarget } from "../src/appTargets";
import type { EligibleTarget, HerdrQueryResult } from "../src/herdr";
import { composePickerTargets } from "../src/pickerTargets";

// A pane target, as mapPane would mint it (kind left implicit ⇒ "herdr").
function pane(id: string): EligibleTarget {
  return {
    target: id,
    label: `claude · idle — ${id}`,
    agentStatus: "idle",
    agent: "claude",
    cwd: `C:\\dev\\${id}`,
  };
}

const chatgpt = appTargetToEligibleTarget({
  id: "chatgpt",
  label: "ChatGPT",
  process: "ChatGPT",
  glyph: "chatgpt",
});

// A recognizable anchor decorator: tags panes so we can prove it touched them.
const tag = (t: EligibleTarget): EligibleTarget => ({ ...t, label: `${t.label}#anchored` });

test("panes come first (low digits), app targets append after", () => {
  const result = composePickerTargets(
    { kind: "targets", targets: [pane("a"), pane("b")] },
    [chatgpt],
    tag,
  );
  assert.equal(result.kind, "targets");
  const targets = (result as { targets: readonly EligibleTarget[] }).targets;
  assert.deepEqual(
    targets.map((t) => t.target),
    ["a", "b", "app:chatgpt"],
  );
});

test("anchorPane is applied to panes only — never to app targets", () => {
  let calls = 0;
  const result = composePickerTargets(
    { kind: "targets", targets: [pane("a")] },
    [chatgpt],
    (t) => {
      calls += 1;
      return tag(t);
    },
  );
  const targets = (result as { targets: readonly EligibleTarget[] }).targets;
  assert.equal(calls, 1, "anchorPane runs once — for the single pane, not the app");
  assert.match(targets[0].label, /#anchored$/);
  assert.equal(targets[1].label, "ChatGPT"); // app label untouched
});

test("Herdr unavailable + app targets ⇒ the apps remain offerable (survive Herdr-down)", () => {
  const down: HerdrQueryResult = {
    kind: "unavailable",
    code: "herdr-not-found",
    message: "Herdr isn't installed or running — Clipboard only, sir.",
  };
  const result = composePickerTargets(down, [chatgpt], tag);
  assert.deepEqual(result, { kind: "targets", targets: [chatgpt] });
});

test("Herdr failed (timeout) + app targets ⇒ still offers the apps", () => {
  const failed: HerdrQueryResult = {
    kind: "failed",
    code: "pane-query-timeout",
    message: "Herdr took too long to answer — Clipboard only, sir.",
  };
  const result = composePickerTargets(failed, [chatgpt], tag);
  assert.deepEqual(result, { kind: "targets", targets: [chatgpt] });
});

test("Herdr unavailable + NO app targets ⇒ the failure result passes through untouched", () => {
  const down: HerdrQueryResult = {
    kind: "unavailable",
    code: "herdr-not-found",
    message: "Herdr isn't installed or running — Clipboard only, sir.",
  };
  // Byte-identical to today: the toast + "Clipboard only" picker survive.
  assert.deepEqual(composePickerTargets(down, [], tag), down);
});

test("a full fleet reserves a slot for the app — the 8th pane is displaced, not the app", () => {
  const panes = Array.from({ length: 8 }, (_, i) => pane(`p${i}`));
  const result = composePickerTargets({ kind: "targets", targets: panes }, [chatgpt], tag);
  const targets = (result as { targets: readonly EligibleTarget[] }).targets;
  assert.equal(targets.length, 8, "the shared 8-slot digit space stays capped");
  assert.equal(targets[7].target, "app:chatgpt", "the app keeps the last digit");
  assert.deepEqual(
    targets.slice(0, 7).map((t) => t.target),
    ["p0", "p1", "p2", "p3", "p4", "p5", "p6"], // p7 displaced
  );
});
