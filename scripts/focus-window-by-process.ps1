# Win32 shim: bring a visible top-level window belonging to a named PROCESS to
# the OS foreground. Sibling of focus-window-by-title.ps1 — same ForceForeground
# machinery, different way of FINDING the window. Knows nothing about Mistr Flow
# or ChatGPT; the caller owns that (src/appWindow.ts).
#
# Why process, not title: an app-target window (e.g. ChatGPT) has an ordinary,
# user-mutable title — it becomes the current chat's name on a popped-out window
# — so exact-title matching is fragile. The process name is stable. A -Title is
# accepted as a fallback (matched exactly) for the rare case a process match
# misses (a popped-out window owned by a differently-named helper process).
#
# The visible + NON-EMPTY-TITLE filter is what lands the real app window rather
# than an invisible Electron helper/GPU window sharing the pid.
#
# Exit codes are the contract (stdout is the resolved HWND on success), IDENTICAL
# to focus-window-by-title.ps1 so src/appWindow.ts maps them the same way:
#   0 = focused   3 = no window matched   4 = window found, focus refused
param(
  [string]$Process,
  [string]$Title
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
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

  /// First VISIBLE, NON-EMPTY-TITLE top-level window whose owning pid is in the
  /// set. The title filter skips a process's invisible helper/GPU windows.
  public static IntPtr FindByProcess(int[] pids) {
    var wanted = new HashSet<int>(pids);
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (wanted.Contains((int)pid)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  /// Exact-title match over visible top-level windows (the fallback matcher).
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
  /// the current foreground thread's input queue lifts that restriction. Retries
  /// because SW_RESTORE starts an un-minimize animation that refuses a same-frame
  /// SetForegroundWindow (an intermittent failure otherwise impossible to see).
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

# Resolve the process name to its live pids once (cheap; avoids per-window
# GetProcessById calls that throw when a process exits mid-enum).
$procIds = @()
if ($Process) {
  try {
    $procIds = @(Get-Process -Name $Process -ErrorAction Stop | Select-Object -ExpandProperty Id)
  } catch {
    $procIds = @()
  }
}

$hwnd = [IntPtr]::Zero
if ($procIds.Count -gt 0) {
  $hwnd = [MfFocus]::FindByProcess([int[]]$procIds)
}
# Fallback to the exact title if the process match found nothing.
if ($hwnd -eq [IntPtr]::Zero -and $Title) {
  $hwnd = [MfFocus]::FindByTitle($Title)
}

if ($hwnd -eq [IntPtr]::Zero) { exit 3 }
if (-not [MfFocus]::ForceForeground($hwnd)) { exit 4 }
Write-Output $hwnd.ToInt64()
exit 0
