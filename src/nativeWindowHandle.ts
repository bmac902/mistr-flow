/**
 * Electron's `getNativeWindowHandle()` returns the platform HWND as a raw
 * little-endian pointer Buffer, but the capture helper's `-ExcludeHwnd` flag
 * (scripts/capture-active-window.ps1) takes it as a decimal string — this
 * decodes the buffer so a bad handle fails loudly rather than leaving the
 * self-capture exclusion silently inert.
 */
export function nativeWindowHandleToHwnd(buffer: Buffer): string {
  if (buffer.length >= 8) {
    return buffer.readBigInt64LE(0).toString();
  }
  if (buffer.length >= 4) {
    return buffer.readInt32LE(0).toString();
  }
  return "0";
}
