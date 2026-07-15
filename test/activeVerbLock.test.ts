import assert from "node:assert/strict";
import test from "node:test";

import { createActiveVerbLock } from "../src/activeVerbLock";

test("starts a verb from idle and reports it as active", () => {
  const lock = createActiveVerbLock();

  assert.equal(lock.activeVerb(), null);
  assert.equal(lock.tryStart("dictation"), true);
  assert.equal(lock.activeVerb(), "dictation");
});

test("synchronously refuses a second verb while the first is still active — no queueing", () => {
  const lock = createActiveVerbLock();

  assert.equal(lock.tryStart("dictation"), true);
  assert.equal(lock.tryStart("capture"), false);
  assert.equal(lock.activeVerb(), "dictation");
});

test("refuses near-simultaneous callbacks racing for the lock — only one check-and-set wins", () => {
  const lock = createActiveVerbLock();
  const results: boolean[] = [];

  // Simulates two global-shortcut callbacks firing back-to-back with no
  // await between them, the scenario a pure policy check alone can't guard.
  results.push(lock.tryStart("dictation"));
  results.push(lock.tryStart("capture"));

  assert.deepEqual(results, [true, false]);
});

test("release frees the lock for a new verb to start", () => {
  const lock = createActiveVerbLock();

  lock.tryStart("dictation");
  lock.release("dictation");

  assert.equal(lock.activeVerb(), null);
  assert.equal(lock.tryStart("capture"), true);
});

test("releasing a verb that is not the active one is a no-op", () => {
  const lock = createActiveVerbLock();

  lock.tryStart("dictation");
  lock.release("capture");

  assert.equal(lock.activeVerb(), "dictation");
});
