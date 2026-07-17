# Win32 shim: return the HWND of the visible top-level window with an exact
# title, WITHOUT raising or focusing it. Knows nothing about Herdr — the caller
# owns that (src/doneChime.ts). The focusing cousin is focus-window-by-title.ps1;
# this one only *identifies*, so the done-chime foreground check can find Herdr's
# host window once and cache the handle (ADR 0002 minted-title identification).
#
# Exit codes are the contract (stdout is the resolved HWND on success):
#   0 = found (HWND on stdout)   3 = no window matched that title
param(
  [Parameter(Mandatory = $true)][string]$Title
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class MfFind {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);

  /// Exact-title match over visible top-level windows. Exact (not substring) so a
  /// caller-minted nonce can never collide with an unrelated window.
  public static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (string.Equals(sb.ToString(), title, StringComparison.Ordinal)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$hwnd = [MfFind]::FindByTitle($Title)
if ($hwnd -eq [IntPtr]::Zero) { exit 3 }
Write-Output $hwnd.ToInt64()
exit 0
