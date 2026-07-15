# Win32 shim: bring the visible top-level window with an exact title to the OS
# foreground. Knows nothing about Herdr — the caller owns that (src/herdrWindow.ts).
#
# Why this exists at all: Herdr is a TUI with no window of its own (both herdr.exe
# processes report MainWindowHandle=0). Its UI is painted by a host terminal
# (Windows Terminal), so `herdr agent focus` moves focus *inside* a window nobody
# ever raises. Raising that host window is not something Herdr's API can do, and
# is the whole reason focusOnDeliver produced no visible effect.
#
# Verified live on Windows 11 / WindowsTerminal 1.24 (2026-07-15):
#   - Naive SetForegroundWindow from a background process FAILS (foreground lock).
#   - AttachThreadInput to the current foreground thread first makes it succeed.
#   - COM AppActivate is faster but returns False on a MINIMIZED window and leaves
#     it iconic, so SW_RESTORE must come first. That is why we don't use it.
#
# Exit codes are the contract (stdout is the resolved HWND on success):
#   0 = focused   3 = no window matched that title   4 = window found, focus refused
param(
  [Parameter(Mandatory = $true)][string]$Title
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class MfFocus {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  // Undocumented but stable since XP; this is what Alt-Tab itself uses, and it
  // succeeds in cases where SetForegroundWindow is refused outright.
  [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

  private const int SW_RESTORE = 9;

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

  private static void TryOnce(IntPtr hWnd) {
    // Re-read the foreground every attempt: un-minimizing can change it underneath us.
    IntPtr fg = GetForegroundWindow();
    uint pid;
    uint fgThread = GetWindowThreadProcessId(fg, out pid);
    uint myThread = GetCurrentThreadId();

    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
    try {
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(myThread, fgThread, false);
    }
  }

  /// Windows only grants foreground to the process that already owns it. Borrowing
  /// the current foreground thread's input queue lifts that restriction.
  ///
  /// Retries rather than firing once: SW_RESTORE starts an un-minimize animation,
  /// and a SetForegroundWindow issued while it is still in flight gets refused —
  /// observed live as an intermittent failure, which is exactly the kind of bug
  /// that is impossible to diagnose from the far side of a screen.
  public static bool ForceForeground(IntPtr hWnd) {
    if (IsIconic(hWnd)) {
      ShowWindow(hWnd, SW_RESTORE);   // SetForegroundWindow alone never un-minimizes
      Thread.Sleep(120);              // let the restore settle before competing for foreground
    }
    if (GetForegroundWindow() == hWnd) return true;

    for (int i = 0; i < 5; i++) {
      TryOnce(hWnd);
      if (GetForegroundWindow() == hWnd) return true;
      Thread.Sleep(80);
      if (GetForegroundWindow() == hWnd) return true;
    }

    // Last resort before giving up.
    SwitchToThisWindow(hWnd, true);
    Thread.Sleep(120);
    return GetForegroundWindow() == hWnd;
  }
}
"@

$hwnd = [MfFocus]::FindByTitle($Title)
if ($hwnd -eq [IntPtr]::Zero) { exit 3 }
if (-not [MfFocus]::ForceForeground($hwnd)) { exit 4 }
Write-Output $hwnd.ToInt64()
exit 0
