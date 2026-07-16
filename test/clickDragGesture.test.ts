import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAG_THRESHOLD_PX,
  createClickDragGesture,
} from "../src/clickDragGesture";

test("a press with no movement is a click", () => {
  const gesture = createClickDragGesture(100, 100);

  assert.equal(gesture.end(), "click");
});

test("movement within the threshold stays a click and moves the overlay by nothing", () => {
  const gesture = createClickDragGesture(100, 100);

  // A 3px nudge (under the 4px threshold) — hand jitter on a click.
  assert.deepEqual(gesture.move(102, 102), { deltaX: 0, deltaY: 0 });
  assert.equal(gesture.end(), "click");
});

test("movement over the threshold becomes a drag", () => {
  const gesture = createClickDragGesture(100, 100);

  gesture.move(110, 100);
  assert.equal(gesture.end(), "drag");
});

test("the crossing move catches the overlay up to the pointer with no dead-zone offset", () => {
  const gesture = createClickDragGesture(100, 100);

  // First move stays inside the dead zone: no overlay movement.
  assert.deepEqual(gesture.move(102, 101), { deltaX: 0, deltaY: 0 });
  // This move crosses the threshold; the overlay jumps by the FULL displacement
  // from the origin, not just the step, so it lands under the pointer.
  assert.deepEqual(gesture.move(110, 105), { deltaX: 10, deltaY: 5 });
});

test("drag moves after the crossing report incremental steps", () => {
  const gesture = createClickDragGesture(0, 0);

  assert.deepEqual(gesture.move(10, 0), { deltaX: 10, deltaY: 0 }); // crossing
  assert.deepEqual(gesture.move(15, 3), { deltaX: 5, deltaY: 3 });
  assert.deepEqual(gesture.move(15, 3), { deltaX: 0, deltaY: 0 });
  assert.deepEqual(gesture.move(12, 3), { deltaX: -3, deltaY: 0 });
  assert.equal(gesture.end(), "drag");
});

test("once a drag, always a drag — wandering back inside the threshold does not revert", () => {
  const gesture = createClickDragGesture(100, 100);

  gesture.move(110, 100); // crosses
  gesture.move(100, 100); // back at the origin
  assert.equal(gesture.end(), "drag");
});

test("the threshold is measured as straight-line distance from the origin", () => {
  // A diagonal move whose per-axis deltas are each under the threshold but whose
  // hypotenuse exceeds it still counts as a drag.
  const gesture = createClickDragGesture(0, 0);

  gesture.move(3, 3); // hypot ≈ 4.24 > 4
  assert.equal(gesture.end(), "drag");
});

test("movement exactly at the threshold is still a click (dead zone is inclusive)", () => {
  const gesture = createClickDragGesture(0, 0);

  assert.deepEqual(gesture.move(DRAG_THRESHOLD_PX, 0), { deltaX: 0, deltaY: 0 });
  assert.equal(gesture.end(), "click");
});
