import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  OVERLAY_BOTTOM_MARGIN,
  OVERLAY_WINDOW_HEIGHT,
  OVERLAY_WINDOW_WIDTH,
  clampOverlayPosition,
  resolveOverlayPosition,
} from "../src/overlayPosition";

const workArea = { x: 100, y: 50, width: 1200, height: 800 };

test("resolveOverlayPosition falls back to bottom-center when no saved position exists", () => {
  const position = resolveOverlayPosition({ workArea });

  assert.deepEqual(position, {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WINDOW_WIDTH) / 2),
    y: workArea.y + workArea.height - OVERLAY_WINDOW_HEIGHT - OVERLAY_BOTTOM_MARGIN,
  });
});

test("resolveOverlayPosition restores a saved overlay position", () => {
  const position = resolveOverlayPosition({
    workArea,
    savedPosition: { x: 240, y: 180 },
  });

  assert.deepEqual(position, { x: 240, y: 180 });
});

test("resolveOverlayPosition clamps an off-screen saved overlay position into the work area", () => {
  const position = resolveOverlayPosition({
    workArea,
    savedPosition: { x: 5000, y: -900 },
  });

  assert.deepEqual(position, {
    x: workArea.x + workArea.width - OVERLAY_WINDOW_WIDTH,
    y: workArea.y,
  });
});

test("clampOverlayPosition keeps dragged positions inside the work area", () => {
  assert.deepEqual(clampOverlayPosition({ x: -400, y: 2000 }, workArea), {
    x: workArea.x,
    y: workArea.y + workArea.height - OVERLAY_WINDOW_HEIGHT,
  });
});
