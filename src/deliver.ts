import { execFile as nodeExecFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";

import type { CaptureArtifact } from "./capture";
import type { CaptureDeliverOutcome } from "./captureSession";
import { readHerdrSocketPath, type EligibleTarget } from "./herdr";
import { raiseHerdrWindow, type HerdrWindowOutcome } from "./herdrWindow";

// Delivery execution (issue #32, PRD #24) — the mechanism proven by the live
// spike (#28 findings, 2026-07-15) and only that mechanism: inject the
// capture's exact absolute PNG path as the message text of
// `herdr agent send <target> <path>`. Herdr's own image-path detection
// upgrades the injected reference into a real multimodal attachment in the
// pane — MF never sends keystrokes into it, and only focuses it when the user
// opts in via `focusOnDeliver` (ADR 0001; focus mechanics in src/herdrWindow.ts).
// `agent send` (not `pane run`) is required for two reasons, both confirmed
// live: `pane run` only accepts the compact/positional pane_id, not the
// durable target identity this adapter is handed; and `agent send` writes
// text only, never Enter — the reference lands in the pane's input box for
// the human to add context to and send themselves, deliberately not
// auto-submitted (CONTEXT.md, 2026-07-15).
// The spike also found a bad/nonexistent path doesn't fail cleanly — it can
// stall on an interactive prompt at the human's pane — so deliver() verifies
// the file exists itself before ever injecting anything.

export type DeliveryFailureCode =
  | "delivery-file-missing"
  | "delivery-id-mismatch"
  | "herdr-not-found"
  | "delivery-pane-run-failed";

const SAFE_MESSAGES: Record<DeliveryFailureCode, string> = {
  "delivery-file-missing": "That capture's gone missing — nothing to deliver, sir.",
  "delivery-id-mismatch":
    "That capture doesn't match this delivery — try a fresh one, sir.",
  "herdr-not-found": "Herdr isn't installed or running — Clipboard only, sir.",
  "delivery-pane-run-failed": "That pane has left the building — Clipboard only, sir.",
};

/** The only text a consumer may render for a failure. Never raw error output. */
export function safeMessageFor(code: DeliveryFailureCode): string {
  return SAFE_MESSAGES[code];
}

type ExecCallbackError = (Error & { code?: string | number }) | null;

/** Minimal `execFile` shape — mirrors node's callback contract for mocking. */
export type DeliverExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (error: ExecCallbackError, stdout: string, stderr: string) => void,
) => void;

export type RaiseHerdrWindowFn = (args: {
  readonly socketPath: string | null;
}) => Promise<HerdrWindowOutcome>;

export type ReadHerdrSocketPathFn = () => Promise<string | null>;

export interface DeliveryAdapterDeps {
  readonly execFile?: DeliverExecFile;
  readonly pathExists?: (filePath: string) => Promise<boolean>;
  /**
   * Opt-in only (config `focusOnDeliver`, default false). A deliberate,
   * user-chosen exception to "never steal focus" — the delivery mechanism
   * itself never needs it. Best-effort: a focus failure never turns a
   * successful delivery into a failed one.
   */
  readonly focusOnDeliver?: boolean;
  readonly raiseWindow?: RaiseHerdrWindowFn;
  readonly readSocketPath?: ReadHerdrSocketPathFn;
}

const defaultExecFile: DeliverExecFile = (file, args, callback) => {
  nodeExecFile(file, [...args], (error, stdout, stderr) => {
    callback(error as ExecCallbackError, stdout ?? "", stderr ?? "");
  });
};

const defaultPathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
};

interface DeliveryRecord {
  readonly pngPath: string;
  readonly target: string;
  readonly outcome: Promise<CaptureDeliverOutcome>;
}

export type DeliverFn = (
  capture: CaptureArtifact,
  target: EligibleTarget,
) => Promise<CaptureDeliverOutcome>;

/**
 * Builds the `deliver` dependency for `runCaptureSession`. Owns an in-memory
 * ledger keyed by capture id so a retry (same artifact, same target) can
 * never inject twice — it hands back the original in-flight/settled attempt
 * instead of shelling out again. A capture id reused against a different
 * target or a different pngPath (payload) is rejected outright: never
 * silently delivered against a stale or mismatched destination.
 */
export function createHerdrDeliveryAdapter(
  deps: DeliveryAdapterDeps = {},
): DeliverFn {
  const execFile = deps.execFile ?? defaultExecFile;
  const pathExists = deps.pathExists ?? defaultPathExists;
  const focusOnDeliver = deps.focusOnDeliver ?? false;
  const raiseWindow = deps.raiseWindow ?? ((args) => raiseHerdrWindow(args));
  const readSocketPath = deps.readSocketPath ?? (() => readHerdrSocketPath());
  const ledger = new Map<string, DeliveryRecord>();

  return function deliver(
    capture: CaptureArtifact,
    target: EligibleTarget,
  ): Promise<CaptureDeliverOutcome> {
    const existing = ledger.get(capture.id);
    if (existing) {
      if (existing.pngPath !== capture.pngPath || existing.target !== target.target) {
        return Promise.resolve(failure("delivery-id-mismatch"));
      }
      return existing.outcome;
    }

    const outcome = runDelivery(
      execFile,
      pathExists,
      capture,
      target,
      focusOnDeliver,
      raiseWindow,
      readSocketPath,
    );
    ledger.set(capture.id, {
      pngPath: capture.pngPath,
      target: target.target,
      outcome,
    });
    return outcome;
  };
}

async function runDelivery(
  execFile: DeliverExecFile,
  pathExists: (filePath: string) => Promise<boolean>,
  capture: CaptureArtifact,
  target: EligibleTarget,
  focusOnDeliver: boolean,
  raiseWindow: RaiseHerdrWindowFn,
  readSocketPath: ReadHerdrSocketPathFn,
): Promise<CaptureDeliverOutcome> {
  const exists = await pathExists(capture.pngPath);
  if (!exists) {
    return failure("delivery-file-missing");
  }

  const outcome = await runHerdrAgentSend(execFile, target.target, capture.pngPath);
  if (outcome.kind === "delivered" && focusOnDeliver) {
    await focusDeliveredPane(execFile, target.target, raiseWindow, readSocketPath);
  }
  return outcome;
}

/**
 * Focus has two halves and needs both — this is what v1's focusOnDeliver was
 * missing. `herdr agent focus` moves focus *inside* Herdr (it cascades
 * workspace+tab+pane on its own; no separate workspace/tab focus call is
 * needed — confirmed in Herdr's server log). But Herdr is a TUI with no window
 * of its own, so that alone is invisible: the host terminal still has to be
 * raised to the OS foreground. See src/herdrWindow.ts.
 *
 * Best-effort throughout — a focus failure never turns a delivery into a failure.
 */
async function focusDeliveredPane(
  execFile: DeliverExecFile,
  target: string,
  raiseWindow: RaiseHerdrWindowFn,
  readSocketPath: ReadHerdrSocketPathFn,
): Promise<void> {
  const focused = await runHerdrAgentFocus(execFile, target);
  if (!focused) return;

  const socketPath = await readSocketPath();
  const outcome = await raiseWindow({ socketPath });
  if (outcome.kind === "raised") {
    console.log("[mistr-flow] focusOnDeliver: raised herdr window", outcome.hwnd);
  } else {
    console.warn(
      "[mistr-flow] focusOnDeliver: pane focused but window not raised:",
      outcome.code,
    );
  }
}

/** Best-effort only — a focus failure never turns a delivery into a failure. */
function runHerdrAgentFocus(
  execFile: DeliverExecFile,
  target: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("herdr", ["agent", "focus", target], (error, _stdout, stderr) => {
      if (error) {
        console.warn(
          "[mistr-flow] focusOnDeliver: herdr agent focus failed:",
          stderr || error.message,
        );
        resolve(false);
        return;
      }
      console.log("[mistr-flow] focusOnDeliver: focused target", target);
      resolve(true);
    });
  });
}

function runHerdrAgentSend(
  execFile: DeliverExecFile,
  target: string,
  pngPath: string,
): Promise<CaptureDeliverOutcome> {
  return new Promise((resolve) => {
    execFile("herdr", ["agent", "send", target, pngPath], (error) => {
      if (!error) {
        resolve({ kind: "delivered" });
        return;
      }
      if (typeof error.code === "string") {
        // Spawn failure (ENOENT/EACCES/…): the binary isn't there to run.
        resolve(failure("herdr-not-found"));
        return;
      }
      // Non-zero exit: the CLI ran but the pane rejected/couldn't take it.
      resolve(failure("delivery-pane-run-failed"));
    });
  });
}

function failure(code: DeliveryFailureCode): CaptureDeliverOutcome {
  return { kind: "failed", code, message: safeMessageFor(code) };
}
