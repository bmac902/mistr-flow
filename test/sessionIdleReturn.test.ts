import assert from "node:assert/strict";
import test from "node:test";

import { createSessionIdleReturn } from "../src/sessionIdleReturn";

test("delays the idle overlay until slow cleanup completes when the idle timer fires first", () => {
  let active = true;
  const events: string[] = [];
  const timers: Array<() => void> = [];

  const idleReturn = createSessionIdleReturn({
    delayMs: 5000,
    isActive: () => active,
    hasActiveSession: () => active,
    sendIdle: () => events.push("idle"),
    setTimeout(callback) {
      timers.push(callback);
      return 0;
    },
  });

  idleReturn.schedule();
  assert.equal(timers.length, 1);

  timers[0]();
  assert.deepEqual(events, []);

  active = false;
  idleReturn.afterCleanup();
  assert.deepEqual(events, ["idle"]);
});

test("keeps the existing delayed idle behavior when cleanup finishes before the timer", () => {
  let active = true;
  const events: string[] = [];
  const timers: Array<() => void> = [];

  const idleReturn = createSessionIdleReturn({
    delayMs: 5000,
    isActive: () => active,
    hasActiveSession: () => active,
    sendIdle: () => events.push("idle"),
    setTimeout(callback) {
      timers.push(callback);
      return 0;
    },
  });

  idleReturn.schedule();
  active = false;
  idleReturn.afterCleanup();
  assert.deepEqual(events, []);

  timers[0]();
  assert.deepEqual(events, ["idle"]);
});

test("does not let an old session timer force idle over a newer active session", () => {
  let currentSessionActive = true;
  let anySessionActive = true;
  const events: string[] = [];
  const timers: Array<() => void> = [];

  const idleReturn = createSessionIdleReturn({
    delayMs: 5000,
    isActive: () => currentSessionActive,
    hasActiveSession: () => anySessionActive,
    sendIdle: () => events.push("idle"),
    setTimeout(callback) {
      timers.push(callback);
      return 0;
    },
  });

  idleReturn.schedule();
  currentSessionActive = false;
  anySessionActive = true;

  timers[0]();

  assert.deepEqual(events, []);
});
