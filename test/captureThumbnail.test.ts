import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureArtifact } from "../src/capture";
import {
  CAPTURE_PREVIEW_BOX,
  fitWithin,
  renderCapturePreview,
  type ThumbnailImagePort,
  type ThumbnailSize,
} from "../src/captureThumbnail";

const ARTIFACT: CaptureArtifact = {
  id: "capture-uuid-1",
  pngPath: "/tmp/MistrFlowCaptures/capture-uuid-1.png",
  windowTitle: "Mozilla Firefox — GitHub",
  processName: "firefox",
  takenAt: "2026-07-15T10:00:00.000Z",
};

interface FakeImageOptions {
  size?: ThumbnailSize;
  empty?: boolean;
  dataUrl?: string;
  onResize?: (size: ThumbnailSize) => void;
  throwOnLoad?: boolean;
}

function fakeImage(options: FakeImageOptions = {}): ThumbnailImagePort {
  const size = options.size ?? { width: 1920, height: 1080 };
  return {
    getSize: () => size,
    isEmpty: () => options.empty ?? false,
    resize(next) {
      options.onResize?.(next);
      return fakeImage({ ...options, size: next });
    },
    toDataURL: () =>
      options.dataUrl ?? "data:image/png;base64,aGVsbG8=",
  };
}

function loaderFor(options: FakeImageOptions = {}) {
  return (_pngPath: string): ThumbnailImagePort => {
    if (options.throwOnLoad) throw new Error("boom");
    return fakeImage(options);
  };
}

// ---------------------------------------------------------------------------
// fitWithin — contain math
// ---------------------------------------------------------------------------

test("fitWithin scales a landscape source down into the box, preserving aspect", () => {
  const fitted = fitWithin({ width: 1920, height: 1080 }, CAPTURE_PREVIEW_BOX);

  assert.deepEqual(fitted, { width: 318, height: 179 });
  assert.ok(fitted.width <= CAPTURE_PREVIEW_BOX.width);
  assert.ok(fitted.height <= CAPTURE_PREVIEW_BOX.height);
});

test("fitWithin scales a portrait source to the box height, not its width", () => {
  const fitted = fitWithin({ width: 900, height: 1400 }, CAPTURE_PREVIEW_BOX);

  // Height-bound: 179/1400 scales width to ~115 — letterboxed, never stretched.
  assert.deepEqual(fitted, { width: 115, height: 179 });
  assert.ok(fitted.width <= CAPTURE_PREVIEW_BOX.width);
});

test("fitWithin fits a square source inside the shorter box dimension", () => {
  const fitted = fitWithin({ width: 1000, height: 1000 }, CAPTURE_PREVIEW_BOX);

  assert.deepEqual(fitted, { width: 179, height: 179 });
});

test("fitWithin never upscales a source already smaller than the box", () => {
  const source = { width: 120, height: 80 };

  assert.deepEqual(fitWithin(source, CAPTURE_PREVIEW_BOX), source);
});

test("fitWithin degrades to 1x1 rather than a zero-dimension resize", () => {
  assert.deepEqual(fitWithin({ width: 0, height: 0 }, CAPTURE_PREVIEW_BOX), {
    width: 1,
    height: 1,
  });
});

// ---------------------------------------------------------------------------
// renderCapturePreview — best-effort by contract
// ---------------------------------------------------------------------------

test("renderCapturePreview returns the data URL and the captured window's title", () => {
  const preview = renderCapturePreview(
    loaderFor({ dataUrl: "data:image/png;base64,Zm9v" }),
    ARTIFACT,
  );

  assert.deepEqual(preview, {
    dataUrl: "data:image/png;base64,Zm9v",
    windowTitle: "Mozilla Firefox — GitHub",
  });
});

test("renderCapturePreview resizes to the fitted size before encoding", () => {
  const resizes: ThumbnailSize[] = [];
  renderCapturePreview(
    loaderFor({
      size: { width: 2560, height: 1440 },
      onResize: (size) => resizes.push(size),
    }),
    ARTIFACT,
  );

  // Resized once, to the contain-fit — not the full-resolution grab.
  assert.deepEqual(resizes, [{ width: 318, height: 179 }]);
});

test("renderCapturePreview returns null for an empty image — createFromPath's miss signal", () => {
  // nativeImage.createFromPath returns an empty image rather than throwing
  // when the file is missing or undecodable, so isEmpty() is the real check.
  const preview = renderCapturePreview(loaderFor({ empty: true }), ARTIFACT);

  assert.equal(preview, null);
});

test("renderCapturePreview returns null when the loader throws", () => {
  const preview = renderCapturePreview(loaderFor({ throwOnLoad: true }), ARTIFACT);

  assert.equal(preview, null);
});

test("renderCapturePreview returns null when encoding yields nothing", () => {
  const preview = renderCapturePreview(loaderFor({ dataUrl: "" }), ARTIFACT);

  assert.equal(preview, null);
});
