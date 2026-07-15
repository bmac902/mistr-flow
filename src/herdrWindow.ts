import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { callHerdrSocket, type HerdrSocketDeps } from "./herdrSocket";

// Why this module exists (the thing focusOnDeliver was missing):
//
// Herdr is a TUI. It owns NO operating-system window — both herdr.exe processes
// report MainWindowHandle=0. Its UI is painted by a host terminal (Windows
// Terminal), which is the only real window in the chain:
//
//   WindowsTerminal.exe  hwnd=67290   <- the only window
//     └─ pwsh.exe        hwnd=0
//        └─ herdr.exe    hwnd=0       (client)
//           └─ herdr.exe hwnd=0       (server) -> agent panes
//
// So `herdr agent focus` does its job perfectly — Herdr's own log confirms it
// cascades workspace+tab+pane — but the result is invisible, because nothing
// raises the host terminal. Herdr's API cannot do it: of its 172 methods not one
// raises a window (only client.window_title.set/clear touch a window at all),
// and it couldn't anyway — the window isn't Herdr's to raise.
//
// Identifying that host window is the hard part: Windows Terminal runs every
// window in ONE process, so pid -> window is one-to-many, and two terminals both
// titled "PowerShell" are indistinguishable from the outside. `MainWindowHandle`
// picks an arbitrary one by z-order. The only durable discriminator is a title
// we mint ourselves: set a nonce as Herdr's window title, find the window
// wearing it, restore the title. That is exact, needs no user setup, and cannot
// collide with an unrelated window.
//
// All of the above verified live on 2026-07-15 (herdr 0.7.2-preview/protocol 16).

export type HerdrWindowSkipCode =
  | "socket-path-unknown"
  | "socket-unreachable"
  | "no-foreground-client"
  | "window-not-found"
  | "foreground-refused"
  | "helper-not-found"
  | "helper-error";

export type HerdrWindowOutcome =
  | { readonly kind: "raised"; readonly hwnd: string }
  | { readonly kind: "skipped"; readonly code: HerdrWindowSkipCode };

type ExecCallbackError = (Error & { code?: string | number }) | null;

export type HerdrWindowExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (error: ExecCallbackError, stdout: string, stderr: string) => void,
) => void;

/** Exit codes are the helper script's contract — see scripts/focus-window-by-title.ps1. */
const EXIT_WINDOW_NOT_FOUND = 3;
const EXIT_FOREGROUND_REFUSED = 4;

const DEFAULT_SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "focus-window-by-title.ps1",
);

export interface HerdrWindowDeps {
  readonly execFile?: HerdrWindowExecFile;
  /** Absolute path to herdr's socket, as reported by `herdr status --json`. */
  readonly socketPath?: string | null;
  readonly scriptPath?: string;
  readonly mintNonce?: () => string;
  readonly socketDeps?: HerdrSocketDeps;
}

const defaultExecFile: HerdrWindowExecFile = (file, args, callback) => {
  nodeExecFile(file, [...args], (error, stdout, stderr) => {
    callback(error as ExecCallbackError, stdout ?? "", stderr ?? "");
  });
};

/**
 * Bring the terminal window hosting Herdr to the OS foreground.
 *
 * Best-effort by contract: every failure is a `skipped` code, never a throw —
 * a capture that was delivered stays delivered even if the window won't come
 * forward. The window title is always restored, including on failure.
 */
export async function raiseHerdrWindow(
  deps: HerdrWindowDeps = {},
): Promise<HerdrWindowOutcome> {
  const socketPath = deps.socketPath;
  if (!socketPath) return { kind: "skipped", code: "socket-path-unknown" };

  const execFile = deps.execFile ?? defaultExecFile;
  const scriptPath = deps.scriptPath ?? DEFAULT_SCRIPT_PATH;
  const mintNonce = deps.mintNonce ?? (() => randomUUID().slice(0, 8));

  // Worn by Herdr's window for a few hundred ms. Reads as intentional rather
  // than as corruption if the process dies before the title is restored.
  const title = `herdr - mistr flow ${mintNonce()}`;

  const setOutcome = await callHerdrSocket(
    socketPath,
    "client.window_title.set",
    { title },
    deps.socketDeps,
  );
  if (setOutcome.kind !== "ok") return { kind: "skipped", code: "socket-unreachable" };
  // Herdr answers `changed:false` with reason `no_foreground_client` when no TUI
  // is attached — there is genuinely no window to raise, so don't run the helper.
  if (setOutcome.result.changed !== true) {
    await clearTitle(socketPath, deps);
    return { kind: "skipped", code: "no-foreground-client" };
  }

  try {
    return await runFocusHelper(execFile, scriptPath, title);
  } finally {
    await clearTitle(socketPath, deps);
  }
}

function clearTitle(socketPath: string, deps: HerdrWindowDeps): Promise<unknown> {
  return callHerdrSocket(socketPath, "client.window_title.clear", {}, deps.socketDeps);
}

function runFocusHelper(
  execFile: HerdrWindowExecFile,
  scriptPath: string,
  title: string,
): Promise<HerdrWindowOutcome> {
  return new Promise((resolve) => {
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-Title",
      title,
    ];
    execFile("powershell", args, (error, stdout) => {
      if (!error) {
        resolve({ kind: "raised", hwnd: stdout.trim() });
        return;
      }
      if (typeof error.code === "string") {
        // Spawn failure (ENOENT/EACCES/…): powershell itself isn't runnable.
        resolve({ kind: "skipped", code: "helper-not-found" });
        return;
      }
      if (error.code === EXIT_WINDOW_NOT_FOUND) {
        resolve({ kind: "skipped", code: "window-not-found" });
        return;
      }
      if (error.code === EXIT_FOREGROUND_REFUSED) {
        resolve({ kind: "skipped", code: "foreground-refused" });
        return;
      }
      resolve({ kind: "skipped", code: "helper-error" });
    });
  });
}
