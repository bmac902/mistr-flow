# Mistr Flow — active-window capture helper (issue #26, PRD #24).
#
# Captures the current foreground window's pixels and metadata from a single
# snapshot and prints a JSON result to stdout. On any failure it writes a
# short error code to stderr and exits non-zero; the TypeScript wrapper
# (src/capture.ts) never routes a failed grab as a successful CaptureArtifact.

[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $env:TEMP 'MistrFlowCaptures'),
  [Int64]$ExcludeHwnd = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MistrFlowCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public static class Native {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  }
}
"@

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4. Must be set before any
# window-metric or pixel read below, or coordinates/pixels come back scaled
# on mixed-DPI setups.
[void][MistrFlowCapture.Native]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

function Fail {
  param([string]$Code)
  [Console]::Error.WriteLine($Code)
  exit 1
}

# Quick heuristic used only to decide whether the screen-rect fallback should
# run. The authoritative non-empty/non-black check lives in the TypeScript
# wrapper, which validates the saved PNG bytes independently of this script.
function Test-BitmapBlank {
  param([System.Drawing.Bitmap]$Bitmap)

  $sampleStepX = [Math]::Max(1, [int]([Math]::Floor($Bitmap.Width / 16)))
  $sampleStepY = [Math]::Max(1, [int]([Math]::Floor($Bitmap.Height / 16)))
  $sawContent = $false

  for ($y = 0; $y -lt $Bitmap.Height -and -not $sawContent; $y += $sampleStepY) {
    for ($x = 0; $x -lt $Bitmap.Width -and -not $sawContent; $x += $sampleStepX) {
      $pixel = $Bitmap.GetPixel($x, $y)
      if ($pixel.A -ne 0 -and ($pixel.R -ne 0 -or $pixel.G -ne 0 -or $pixel.B -ne 0)) {
        $sawContent = $true
      }
    }
  }

  return -not $sawContent
}

# --- Single foreground-window snapshot --------------------------------------
# Every downstream read (title, process, rect, pixels) reuses this one $hwnd
# captured here — never a second GetForegroundWindow call — so metadata and
# pixels can never straddle a focus change.
$hwnd = [MistrFlowCapture.Native]::GetForegroundWindow()
$takenAt = [DateTime]::UtcNow.ToString("o")

if ($hwnd -eq [IntPtr]::Zero) {
  Fail "no-foreground-window"
}

if ($ExcludeHwnd -ne 0 -and $hwnd -eq [IntPtr]$ExcludeHwnd) {
  # Never capture Mistr Flow's own overlay. Content protection on the
  # overlay is a fallback flag, never the default — refusing outright here
  # is the simpler and safer behaviour.
  Fail "own-overlay"
}

$titleLength = [MistrFlowCapture.Native]::GetWindowTextLength($hwnd)
$titleBuilder = New-Object System.Text.StringBuilder ($titleLength + 1)
[void][MistrFlowCapture.Native]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)
$windowTitle = $titleBuilder.ToString()

[uint32]$processId = 0
[void][MistrFlowCapture.Native]::GetWindowThreadProcessId($hwnd, [ref]$processId)
$processName = "unknown"
try {
  $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
} catch {
  $processName = "unknown"
}

$rect = New-Object MistrFlowCapture.RECT
if (-not [MistrFlowCapture.Native]::GetWindowRect($hwnd, [ref]$rect)) {
  Fail "window-rect-unavailable"
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  Fail "window-not-capturable"
}

# --- PrintWindow-first, screen-rect fallback --------------------------------
$size = New-Object System.Drawing.Size $width, $height
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$PW_RENDERFULLCONTENT = 0x00000002
$printed = [MistrFlowCapture.Native]::PrintWindow($hwnd, $hdc, $PW_RENDERFULLCONTENT)
$graphics.ReleaseHdc($hdc)

if (-not $printed -or (Test-BitmapBlank $bitmap)) {
  $visible = [MistrFlowCapture.Native]::IsWindowVisible($hwnd)
  $minimized = [MistrFlowCapture.Native]::IsIconic($hwnd)

  $graphics.Dispose()
  $bitmap.Dispose()

  if (-not $visible -or $minimized) {
    Fail "capture-not-visible"
  }

  # Screen-rect fallback is only reached when the target is visibly
  # capturable, and it captures the same foreground window's rect — never
  # MF's own overlay, which was already ruled out above.
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $size)
}

$graphics.Dispose()

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pngPath = Join-Path $OutDir ([Guid]::NewGuid().ToString() + ".png")
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

$result = [ordered]@{
  windowTitle = $windowTitle
  processName = $processName
  pngPath     = $pngPath
  takenAt     = $takenAt
}
$result | ConvertTo-Json -Compress
