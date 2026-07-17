import { execFile as nodeExecFile } from "node:child_process";
import path from "node:path";

import type { AppTargetView } from "./appTargets";

// Focus an app-target's window (ChatGPT-as-target, 2026-07-17). Wraps the Win32
// process-focus helper (scripts/focus-window-by-process.ps1) and maps its
// exit-code contract to a typed outcome.
//
// The crucial difference from src/herdrWindow.ts's raise: for Herdr, focus is a
// cosmetic opt-in (focusOnDeliver) and a focus failure never fails delivery. For
// an app target FOCUS IS THE DELIVERY MECHANISM — the paste lands in whatever is
// foreground — so a non-`focused` outcome must FAIL the delivery (src/appDeliver.ts),
// never paste blind. This module still never throws: every failure is a typed kind.

export type AppWindowOutcome =
  | { readonly kind: "focused"; readonly hwnd: string }
  | { readonly kind: "window-not-found" }
  | { readonly kind: "foreground-refused" }
  | { readonly kind: "helper-not-found" }
  | { readonly kind: "helper-error" };

type ExecCallbackError = (Error & { code?: string | number }) | null;

export type AppWindowExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (error: ExecCallbackError, stdout: string, stderr: string) => void,
) => void;

/** Exit codes are the helper script's contract — see scripts/focus-window-by-process.ps1. */
const EXIT_WINDOW_NOT_FOUND = 3;
const EXIT_FOREGROUND_REFUSED = 4;

const DEFAULT_SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "focus-window-by-process.ps1",
);

export interface AppWindowDeps {
  readonly execFile?: AppWindowExecFile;
  readonly scriptPath?: string;
}

const defaultExecFile: AppWindowExecFile = (file, args, callback) => {
  nodeExecFile(file, [...args], (error, stdout, stderr) => {
    callback(error as ExecCallbackError, stdout ?? "", stderr ?? "");
  });
};

export function focusAppWindow(
  view: AppTargetView,
  deps: AppWindowDeps = {},
): Promise<AppWindowOutcome> {
  const execFile = deps.execFile ?? defaultExecFile;
  const scriptPath = deps.scriptPath ?? DEFAULT_SCRIPT_PATH;

  // normalizeAppTargets guarantees a matcher, but stay honest if handed a
  // match-less view — a window we can't identify is window-not-found, not a crash.
  if (!view.process && !view.title) {
    return Promise.resolve({ kind: "window-not-found" });
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...(view.process ? ["-Process", view.process] : []),
    ...(view.title ? ["-Title", view.title] : []),
  ];

  return new Promise((resolve) => {
    execFile("powershell", args, (error, stdout) => {
      if (!error) {
        resolve({ kind: "focused", hwnd: stdout.trim() });
        return;
      }
      if (typeof error.code === "string") {
        // Spawn failure (ENOENT/EACCES/…): powershell itself isn't runnable.
        resolve({ kind: "helper-not-found" });
        return;
      }
      if (error.code === EXIT_WINDOW_NOT_FOUND) {
        resolve({ kind: "window-not-found" });
        return;
      }
      if (error.code === EXIT_FOREGROUND_REFUSED) {
        resolve({ kind: "foreground-refused" });
        return;
      }
      resolve({ kind: "helper-error" });
    });
  });
}
