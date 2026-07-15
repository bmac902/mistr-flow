import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPTURE_PICKER_ENTRY_HEIGHT,
  CAPTURE_PICKER_LIST_PADDING,
  capturePickerEntryCount,
  capturePickerWindowHeight,
  resolveGrownWindowBounds,
} from "../src/captureWindowBounds";
import { OVERLAY_WINDOW_HEIGHT } from "../src/overlayPosition";

const workArea = { x: 100, y: 50, width: 1200, height: 800 };

const restingBounds = { x: 500, y: 622, width: 292, height: 178 };

test("capturePickerEntryCount always includes the pinned Clipboard slot", () => {
  assert.equal(capturePickerEntryCount(0), 1);
  assert.equal(capturePickerEntryCount(3), 4);
});

test("capturePickerEntryCount caps at 8 Herdr targets (digit slots 2-9)", () => {
  assert.equal(capturePickerEntryCount(8), 9);
  assert.equal(capturePickerEntryCount(20), 9);
});

test("capturePickerWindowHeight grows with entry count off the resting height", () => {
  assert.equal(
    capturePickerWindowHeight(0),
    OVERLAY_WINDOW_HEIGHT + CAPTURE_PICKER_LIST_PADDING + CAPTURE_PICKER_ENTRY_HEIGHT,
  );
  assert.equal(
    capturePickerWindowHeight(2),
    OVERLAY_WINDOW_HEIGHT + CAPTURE_PICKER_LIST_PADDING + 3 * CAPTURE_PICKER_ENTRY_HEIGHT,
  );
});

test("resolveGrownWindowBounds grows upward with the resting bottom edge and center anchored", () => {
  const grownHeight = restingBounds.height + 100;
  const bounds = resolveGrownWindowBounds({ restingBounds, grownHeight, workArea });

  const restingBottom = restingBounds.y + restingBounds.height;
  const restingCenterX = restingBounds.x + restingBounds.width / 2;

  assert.equal(bounds.width, restingBounds.width);
  assert.equal(bounds.height, grownHeight);
  assert.equal(bounds.y + bounds.height, restingBottom);
  assert.equal(bounds.x + bounds.width / 2, restingCenterX);
});

test("resolveGrownWindowBounds returns exactly the resting bounds when grownHeight matches resting height", () => {
  const bounds = resolveGrownWindowBounds({
    restingBounds,
    grownHeight: restingBounds.height,
    workArea,
  });

  assert.deepEqual(bounds, restingBounds);
});

test("resolveGrownWindowBounds clamps into the work area when growth would push above the top edge", () => {
  const nearTopResting = { x: 500, y: workArea.y + 20, width: 292, height: 178 };
  const grownHeight = 5000;

  const bounds = resolveGrownWindowBounds({
    restingBounds: nearTopResting,
    grownHeight,
    workArea,
  });

  assert.equal(bounds.y, workArea.y);
  assert.equal(bounds.height, grownHeight);
});

test("resolveGrownWindowBounds clamps horizontally into the work area", () => {
  const edgeResting = {
    x: workArea.x + workArea.width - 292 - 5,
    y: 622,
    width: 292,
    height: 178,
  };

  const bounds = resolveGrownWindowBounds({
    restingBounds: edgeResting,
    grownHeight: edgeResting.height + 100,
    workArea,
  });

  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert.ok(bounds.x >= workArea.x);
});
