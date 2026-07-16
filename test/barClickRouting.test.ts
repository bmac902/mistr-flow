import assert from "node:assert/strict";
import test from "node:test";

import { routeBarClick } from "../src/barClickRouting";

// The modal gate on the bar's click-to-jump (issue #61, ADR 0005): while a
// picker is open the butler/header is purely a window handle, so a bar click
// is suppressed — a mid-pick jump would yank OS focus to some blocked pane in
// the middle of choosing a destination. The decision is pure so the effect
// layer (main.ts's bar-clicked handler) carries no routing logic of its own.

test("bar click with no picker open routes to the jump — today's resting-bar behavior, untouched", () => {
  assert.equal(routeBarClick({ pickerOpen: false }), "jump");
});

test("bar click while a picker is open is suppressed — the open picker is modal (ADR 0005)", () => {
  assert.equal(routeBarClick({ pickerOpen: true }), "suppressed");
});
