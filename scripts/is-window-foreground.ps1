# Win32 shim: is the given HWND the OS foreground window right now? The cheap,
# no-socket compare behind the fleet-chime foreground gate (src/fleetChime.ts) —
# run once per poll against the cached handle from find-window-by-title.ps1.
# Knows nothing about Herdr; it only compares handles.
#
# Exit codes are the contract:
#   0  = the HWND is the foreground window
#   10 = a valid window, but not the foreground one
#   3  = the HWND no longer refers to a window (stale — caller re-identifies)
param(
  [Parameter(Mandatory = $true)][long]$Hwnd
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class MfForeground {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);

  public static bool Exists(IntPtr hWnd) { return IsWindow(hWnd); }
  public static bool IsForeground(IntPtr hWnd) { return GetForegroundWindow() == hWnd; }
}
"@

$handle = [IntPtr]$Hwnd
if (-not [MfForeground]::Exists($handle)) { exit 3 }
if ([MfForeground]::IsForeground($handle)) { exit 0 }
exit 10
