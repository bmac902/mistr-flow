import { execFile as nodeExecFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";

import type { CaptureArtifact } from "./capture";
import type { CaptureDeliverOutcome } from "./captureSession";
import { readHerdrSocketPath, type EligibleTarget } from "./herdr";
import { raiseHerdrWindow, type HerdrWindowOutcome } from "./herdrWindow";

// Delivery execution (issue #32, PRD #24) — the mechanism proven by the live
// spike (#28 findings, 2026-07-15) and only that mechanism: inject the
// capture's exact absolute PNG path as the message text of
// `herdr agent send <target> <path>`. MF never sends keystrokes into the pane,
// and only focuses it when the user opts in via `focusOnDeliver` (ADR 0001;
// focus mechanics in src/herdrWindow.ts).
//
// Correction (2026-07-15, live): this used to say "Herdr's own image-path
// detection upgrades the injected reference into a real multimodal attachment."
// That is false. **Herdr does nothing with images** — its API schema contains no
// occurrence of image/attach/multimodal/paste/upload/media, and `agent send` is
// literally `<target> <text>`. The upgrade is done by the *receiving agent CLI*
// (Claude Code detecting a path in its own input), not by Herdr.
// Consequence, proven by delivering the same PNG twice: the receiving agent must
// be **idle** when the text arrives. Delivered to an idle pane it attaches;
// delivered mid-turn it lands as inert plain text and stays that way even after
// the human submits it — detection runs when the text arrives, not on submit.
// Either way the core guarantee holds: the agent can always `Read` the path.
// `agent send` (not `pane run`) is required for two reasons, both confirmed
// live: `pane run` only accepts the compact/positional pane_id, not the
// durable target identity this adapter is handed; and `agent send` writes
// text only, never Enter — the reference lands in the pane's input box for
// the human to add context to and send themselves, deliberately not
// auto-submitted (CONTEXT.md, 2026-07-15).
// The spike also found a bad/nonexistent path doesn't fail cleanly — it can
// stall on an interactive prompt at the human's pane — so deliver() verifies
// the file exists itself before ever injecting anything.

/**
 * The payload-agnostic unit of delivery (issue #37). Every delivery path ends
 * in the same primitive — `herdr agent send <target> <string>` — and the only
 * differences are *what string* and *whether a file must exist first*:
 *
 * | payload             | injectText              | requiresFile |
 * |---------------------|-------------------------|--------------|
 * | screenshot          | the PNG's absolute path | that PNG     |
 * | short clipboard text| the text itself         | (none)       |
 * | long clipboard text | the spill file's path   | that .txt    |
 * | clipboard image     | the PNG's absolute path | that PNG     |
 */
export interface SendPayload {
  readonly id: string;
  /** Exactly what gets handed to `herdr agent send`. */
  readonly injectText: string;
  /**
   * A file the payload depends on. `deliver` verifies it exists BEFORE
   * injecting — a bad path doesn't fail cleanly, it can stall on an
   * interactive prompt at the human's pane (#28 spike finding). Absent for
   * inline text: there's no file, so there's nothing to verify.
   */
  readonly requiresFile?: string;
}

/**
 * A CaptureArtifact is one producer of {@link SendPayload}: the injected text
 * and the required file are both the capture's absolute PNG path.
 */
export function captureArtifactToPayload(capture: CaptureArtifact): SendPayload {
  return {
    id: capture.id,
    injectText: capture.pngPath,
    requiresFile: capture.pngPath,
  };
}

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
  readonly injectText: string;
  readonly target: string;
  readonly outcome: Promise<CaptureDeliverOutcome>;
}

export type DeliverFn = (
  payload: SendPayload,
  target: EligibleTarget,
) => Promise<CaptureDeliverOutcome>;

/**
 * Builds the `deliver` dependency for the send session. Owns an in-memory
 * ledger keyed by payload id so a retry (same payload, same target) can never
 * inject twice — it hands back the original in-flight/settled attempt instead
 * of shelling out again. A payload id reused against a different target or a
 * different injected string is rejected outright: never silently delivered
 * against a stale or mismatched destination.
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
    payload: SendPayload,
    target: EligibleTarget,
  ): Promise<CaptureDeliverOutcome> {
    const existing = ledger.get(payload.id);
    if (existing) {
      if (
        existing.injectText !== payload.injectText ||
        existing.target !== target.target
      ) {
        return Promise.resolve(failure("delivery-id-mismatch"));
      }
      return existing.outcome;
    }

    const outcome = runDelivery(
      execFile,
      pathExists,
      payload,
      target,
      focusOnDeliver,
      raiseWindow,
      readSocketPath,
    );
    ledger.set(payload.id, {
      injectText: payload.injectText,
      target: target.target,
      outcome,
    });
    return outcome;
  };
}

async function runDelivery(
  execFile: DeliverExecFile,
  pathExists: (filePath: string) => Promise<boolean>,
  payload: SendPayload,
  target: EligibleTarget,
  focusOnDeliver: boolean,
  raiseWindow: RaiseHerdrWindowFn,
  readSocketPath: ReadHerdrSocketPathFn,
): Promise<CaptureDeliverOutcome> {
  // Only a payload that declares a file has a precondition — inline text has
  // no file, so there is nothing to verify before injecting it.
  if (payload.requiresFile !== undefined) {
    const exists = await pathExists(payload.requiresFile);
    if (!exists) {
      return failure("delivery-file-missing");
    }
  }

  const outcome = await runHerdrAgentSend(execFile, target.target, payload.injectText);
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

/**
 * Wraps multi-line text in bracketed-paste markers so the receiving terminal
 * treats it as ONE atomic paste (found live, 2026-07-15).
 *
 * `agent send` streams its text into the pane's PTY. For a multi-line body the
 * stream arrives in chunks, and the receiving CLI's paste detection reads each
 * chunk as a separate event — observed live as
 * `[Pasted text #1 +10 lines][Pasted text #2 +9 lines]` for a single 20-line
 * send. Worse, where a chunk boundary lands such that a newline is read as
 * *typed* input rather than pasted, that newline is Enter: the leading chunk
 * submits itself and only the tail survives in the input box. That is the
 * "it only pasted the latter half" bug, and it is chunk-boundary dependent —
 * hence intermittent.
 *
 * Bracketing makes it atomic (verified: the same 20-line body arrives as one
 * `[Pasted text #3 +19 lines]`).
 *
 * Deliberately only when the text contains a newline: a single-line body is a
 * PNG/spill *path*, and paths must keep arriving as plain typed text so the
 * receiving agent's own path-detection still upgrades them into a real image
 * attachment (CONTEXT.md, *Auto-attach requires the receiving agent to be
 * idle*). Bracketing those risks silently breaking image delivery.
 */
/** ESC[200~ / ESC[201~ — written as explicit escapes: a raw ESC byte in
 *  source is invisible and one stray editor/linter pass silently kills it. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export function bracketMultilinePaste(text: string): string {
  if (!text.includes("\n")) return text;
  return `${PASTE_START}${text}${PASTE_END}`;
}

function runHerdrAgentSend(
  execFile: DeliverExecFile,
  target: string,
  injectText: string,
): Promise<CaptureDeliverOutcome> {
  return new Promise((resolve) => {
    execFile("herdr", ["agent", "send", target, bracketMultilinePaste(injectText)], (error) => {
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
