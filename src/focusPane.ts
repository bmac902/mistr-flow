import { execFile as nodeExecFile } from "node:child_process";

import { readHerdrSocketPath } from "./herdr";
import { raiseHerdrWindow, type HerdrWindowOutcome } from "./herdrWindow";

// The reusable "go to a Herdr pane" primitive, extracted from focusOnDeliver
// (ADR 0002) so both delivery (src/deliver.ts) and the jump-to-blocked hotkey
// (issue #50, PRD #44) drive the exact same proven machinery rather than
// reinventing focus/raise. Focus has two halves and needs both:
//
//   1. `herdr agent focus <target>` moves focus *inside* Herdr — it cascades
//      workspace+tab+pane on its own (confirmed in Herdr's server log).
//   2. Herdr is a TUI with no window of its own, so (1) alone is invisible: the
//      host terminal still has to be raised to the OS foreground. That is
//      raiseHerdrWindow, which needs Herdr's socket path (readHerdrSocketPath).
//
// Best-effort throughout — the caller decides what a failure means; this never
// throws.

type ExecCallbackError = (Error & { code?: string | number }) | null;

export type FocusPaneExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (error: ExecCallbackError, stdout: string, stderr: string) => void,
) => void;

export type RaiseHerdrWindowFn = (args: {
  readonly socketPath: string | null;
}) => Promise<HerdrWindowOutcome>;

export type ReadHerdrSocketPathFn = () => Promise<string | null>;

export interface FocusPaneDeps {
  readonly execFile?: FocusPaneExecFile;
  readonly raiseWindow?: RaiseHerdrWindowFn;
  readonly readSocketPath?: ReadHerdrSocketPathFn;
}

export type FocusPaneOutcome =
  | { readonly kind: "focused"; readonly raise: HerdrWindowOutcome }
  | { readonly kind: "focus-failed" };

const defaultExecFile: FocusPaneExecFile = (file, args, callback) => {
  nodeExecFile(file, [...args], (error, stdout, stderr) => {
    callback(error as ExecCallbackError, stdout ?? "", stderr ?? "");
  });
};

/**
 * Focus a Herdr pane by durable target, then raise Herdr's host terminal to the
 * OS foreground. Returns `focus-failed` (and skips the raise) if Herdr couldn't
 * focus the pane — e.g. a target that has since closed — so a dead pane never
 * drags a window forward. On success the {@link HerdrWindowOutcome} is returned
 * so the caller can log whether the window actually came forward.
 */
export async function focusHerdrPane(
  target: string,
  deps: FocusPaneDeps = {},
): Promise<FocusPaneOutcome> {
  const execFile = deps.execFile ?? defaultExecFile;
  const raiseWindow = deps.raiseWindow ?? ((args) => raiseHerdrWindow(args));
  const readSocketPath = deps.readSocketPath ?? (() => readHerdrSocketPath());

  const focused = await runHerdrAgentFocus(execFile, target);
  if (!focused) return { kind: "focus-failed" };

  const socketPath = await readSocketPath();
  const raise = await raiseWindow({ socketPath });
  return { kind: "focused", raise };
}

/** Best-effort only — a focus failure is reported, never thrown. */
function runHerdrAgentFocus(
  execFile: FocusPaneExecFile,
  target: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("herdr", ["agent", "focus", target], (error, _stdout, stderr) => {
      if (error) {
        console.warn(
          "[mistr-flow] focus pane: herdr agent focus failed:",
          stderr || error.message,
        );
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}
