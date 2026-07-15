import assert from "node:assert/strict";
import test from "node:test";

import { decideVerbStart } from "../src/verbArbiter";

test("starts a verb from idle", () => {
  assert.equal(decideVerbStart({ activeVerb: null }, "dictation"), "start");
  assert.equal(decideVerbStart({ activeVerb: null }, "capture"), "start");
});

test("refuses dictation while capture is active", () => {
  assert.equal(decideVerbStart({ activeVerb: "capture" }, "dictation"), "refuse");
});

test("refuses capture while dictation is active", () => {
  assert.equal(decideVerbStart({ activeVerb: "dictation" }, "capture"), "refuse");
});

test("refuses re-starting the same verb that is already active (no queueing, no preemption)", () => {
  assert.equal(decideVerbStart({ activeVerb: "dictation" }, "dictation"), "refuse");
  assert.equal(decideVerbStart({ activeVerb: "capture" }, "capture"), "refuse");
});
