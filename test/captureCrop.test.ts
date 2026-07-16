import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_CROP_FRACTION,
  cropCaptureImage,
  isMeaningfulCrop,
  normalizeCropRect,
  toPixelRect,
  type CropImagePort,
  type CropRect,
  type PixelRect,
} from "../src/captureCrop";
import type { ThumbnailSize } from "../src/captureThumbnail";

interface FakeCropOptions {
  size?: ThumbnailSize;
  empty?: boolean;
  croppedEmpty?: boolean;
  png?: Buffer;
  onCrop?: (rect: PixelRect) => void;
  throwOnLoad?: boolean;
}

function fakeImage(options: FakeCropOptions = {}): CropImagePort {
  return {
    getSize: () => options.size ?? { width: 3840, height: 2160 },
    isEmpty: () => options.empty ?? false,
    crop(rect) {
      options.onCrop?.(rect);
      return fakeImage({
        ...options,
        size: { width: rect.width, height: rect.height },
        empty: options.croppedEmpty ?? false,
      });
    },
    toPNG: () => options.png ?? Buffer.from("png-bytes"),
  };
}

function loaderFor(options: FakeCropOptions = {}) {
  return (_pngPath: string): CropImagePort => {
    if (options.throwOnLoad) throw new Error("boom");
    return fakeImage(options);
  };
}

const FULL: CropRect = { x: 0, y: 0, width: 1, height: 1 };

// ---------------------------------------------------------------------------
// normalizeCropRect — a drag in any direction
// ---------------------------------------------------------------------------

test("normalizeCropRect orders corners so dragging up-left matches down-right", () => {
  const downRight = normalizeCropRect({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.8 });
  const upLeft = normalizeCropRect({ x: 0.6, y: 0.8 }, { x: 0.2, y: 0.3 });

  assert.deepEqual(downRight, upLeft);
  assert.equal(downRight.x, 0.2);
  assert.equal(downRight.y, 0.3);
  assert.ok(Math.abs(downRight.width - 0.4) < 1e-9);
  assert.ok(Math.abs(downRight.height - 0.5) < 1e-9);
});

test("normalizeCropRect clamps a drag that left the image", () => {
  const rect = normalizeCropRect({ x: -0.5, y: -2 }, { x: 1.8, y: 1.2 });

  assert.deepEqual(rect, { x: 0, y: 0, width: 1, height: 1 });
});

test("normalizeCropRect treats non-finite input as the origin rather than NaN", () => {
  const rect = normalizeCropRect({ x: Number.NaN, y: 0.5 }, { x: 0.5, y: 0.5 });

  assert.ok(Number.isFinite(rect.x) && Number.isFinite(rect.width));
  assert.deepEqual(rect, { x: 0, y: 0.5, width: 0.5, height: 0 });
});

// ---------------------------------------------------------------------------
// isMeaningfulCrop — a stray click is not a selection
// ---------------------------------------------------------------------------

test("isMeaningfulCrop rejects a stray click but accepts a real drag", () => {
  assert.equal(isMeaningfulCrop({ x: 0.5, y: 0.5, width: 0, height: 0 }), false);
  assert.equal(
    isMeaningfulCrop({ x: 0.1, y: 0.1, width: MIN_CROP_FRACTION / 2, height: 0.5 }),
    false,
    "a sliver in one axis is still a mis-drag",
  );
  assert.equal(isMeaningfulCrop({ x: 0.1, y: 0.1, width: 0.4, height: 0.3 }), true);
});

// ---------------------------------------------------------------------------
// toPixelRect — normalized space onto real pixels
// ---------------------------------------------------------------------------

test("toPixelRect projects a normalized rect onto the image's real pixels", () => {
  const rect = toPixelRect(
    { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
    { width: 3840, height: 2160 },
  );

  assert.deepEqual(rect, { x: 960, y: 1080, width: 1920, height: 540 });
});

test("toPixelRect never runs past the image edge", () => {
  const size = { width: 100, height: 100 };
  const rect = toPixelRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, size);

  assert.ok(rect.x + rect.width <= size.width, "right edge inside the image");
  assert.ok(rect.y + rect.height <= size.height, "bottom edge inside the image");
});

test("toPixelRect never produces a zero-dimension crop", () => {
  const rect = toPixelRect({ x: 0, y: 0, width: 0, height: 0 }, { width: 100, height: 100 });

  assert.equal(rect.width, 1);
  assert.equal(rect.height, 1);
});

// ---------------------------------------------------------------------------
// cropCaptureImage — best-effort by contract
// ---------------------------------------------------------------------------

test("cropCaptureImage crops the ORIGINAL pixels, not the preview's", () => {
  // The whole point of cropping after the grab: selection is coarse, output
  // is full-resolution. A half-width crop of a 3840px grab is 1920 real px.
  const crops: PixelRect[] = [];
  const png = cropCaptureImage(
    loaderFor({ size: { width: 3840, height: 2160 }, onCrop: (r) => crops.push(r) }),
    "/tmp/capture.png",
    { x: 0, y: 0.5, width: 0.5, height: 0.5 },
  );

  assert.ok(png);
  assert.deepEqual(crops, [{ x: 0, y: 1080, width: 1920, height: 1080 }]);
});

test("cropCaptureImage returns null for a stray click — never a 1px capture", () => {
  const png = cropCaptureImage(loaderFor(), "/tmp/capture.png", {
    x: 0.5,
    y: 0.5,
    width: 0.001,
    height: 0.001,
  });

  assert.equal(png, null);
});

test("cropCaptureImage returns null when the source is unreadable", () => {
  assert.equal(cropCaptureImage(loaderFor({ empty: true }), "/tmp/x.png", FULL), null);
  assert.equal(cropCaptureImage(loaderFor({ throwOnLoad: true }), "/tmp/x.png", FULL), null);
});

test("cropCaptureImage returns null when the crop itself yields nothing", () => {
  assert.equal(
    cropCaptureImage(loaderFor({ croppedEmpty: true }), "/tmp/x.png", FULL),
    null,
  );
  assert.equal(
    cropCaptureImage(loaderFor({ png: Buffer.alloc(0) }), "/tmp/x.png", FULL),
    null,
  );
});
