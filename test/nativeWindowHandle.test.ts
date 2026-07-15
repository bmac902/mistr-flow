import assert from "node:assert/strict";
import test from "node:test";

import { nativeWindowHandleToHwnd } from "../src/nativeWindowHandle";

test("nativeWindowHandleToHwnd decodes a 64-bit little-endian pointer buffer", () => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(65942n, 0);

  assert.equal(nativeWindowHandleToHwnd(buffer), "65942");
});

test("nativeWindowHandleToHwnd decodes a 32-bit little-endian pointer buffer", () => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(65942, 0);

  assert.equal(nativeWindowHandleToHwnd(buffer), "65942");
});

test("nativeWindowHandleToHwnd falls back to \"0\" for an unreadable buffer", () => {
  assert.equal(nativeWindowHandleToHwnd(Buffer.alloc(0)), "0");
});
