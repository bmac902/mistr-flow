import { promises as fsPromises } from "node:fs";
import path from "node:path";

import type { AppTargetView } from "./appTargets";
import { focusAppWindow, type AppWindowOutcome } from "./appWindow";
import type { CaptureDeliverOutcome } from "./captureSession";
import {
  missingFileMessage,
  safeMessageFor,
  type DeliverFn,
  type SendPayload,
} from "./deliver";
import type { EligibleTarget } from "./herdr";

// App delivery (ChatGPT-as-target, 2026-07-17): the deliver path for a
// `kind:"app"` target. Where the Herdr adapter streams text into a pane's PTY
// (no focus, no keystrokes), an app target has no PTY — so this is the OTHER
// primitive the codebase already owns: write the payload to the clipboard,
// focus the app's window, and paste (Ctrl+V). Exactly Herald's "Paste here",
// aimed at a specific app rather than whatever happens to be foreground.
//
// Two rules carried over from src/deliver.ts, on purpose:
//   - Idempotency ledger keyed by payload id: the session's unknown→retry loop
//     (captureSession.ts) can re-request the same delivery, and a double PASTE
//     (unlike a double PTY-stream) would visibly duplicate content. The ledger
//     returns the original in-flight/settled outcome instead of pasting twice.
//   - Never auto-submit: paste only, no Enter (deliver.ts's deliberate rule).
//
// Ordering is load-bearing: clipboard is written BEFORE focus (so nothing races
// clipboard ownership), and focus + paste are adjacent (so nothing steals
// foreground between them).

/** App-delivery failure codes (string-compatible with CaptureDeliverOutcome.code). */
export type AppDeliveryFailureCode =
  | "app-window-not-found"
  | "app-foreground-refused"
  | "app-focus-failed";

export interface AppDeliveryDeps {
  /** Injected in tests; defaults to the real process-focus helper. */
  readonly focusWindow?: (view: AppTargetView) => Promise<AppWindowOutcome>;
  /** Put a PNG on the clipboard as a bitmap (main.ts: clipboard.writeImage(nativeImage…)). */
  readonly writeImageToClipboard: (pngPath: string) => void;
  /** Put text on the clipboard (main.ts: clipboard.writeText). */
  readonly writeTextToClipboard: (text: string) => void;
  /** Simulate Ctrl+V into the focused window (main.ts: simulatePasteKeystroke). */
  readonly simulatePaste: () => Promise<void>;
  /** Optional pre-paste composer-focus keystroke (per-target `pasteFocusKeys`). */
  readonly sendKeys?: (keys: string) => Promise<void>;
  /**
   * Focus-settle delay (#99), injected so the settle is testable without real
   * time — the `herdrSocket`/fleet-chime seam pattern. Defaults to a
   * setTimeout-based sleep.
   */
  readonly delay?: (ms: number) => Promise<void>;
  readonly pathExists?: (filePath: string) => Promise<boolean>;
  readonly readTextFile?: (filePath: string) => Promise<string>;
}

/**
 * Default focus-settle for an app target with no per-target `pasteDelayMs`
 * (#99): long enough to beat the webview's window-focus → composer-focus gap,
 * short enough to be imperceptible on a deliberate delivery. A starting point —
 * the real value is settled in host verification and tuned per-target in config.
 */
const DEFAULT_PASTE_SETTLE_MS = 150;

interface DeliveryRecord {
  readonly injectText: string;
  readonly target: string;
  readonly outcome: Promise<CaptureDeliverOutcome>;
}

const defaultPathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const defaultReadTextFile = (filePath: string): Promise<string> =>
  fsPromises.readFile(filePath, "utf8");

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the app `deliver`. Owns an in-memory ledger keyed by payload id,
 * structurally identical to {@link createHerdrDeliveryAdapter}: a retry (same
 * payload, same target) returns the original attempt rather than pasting again;
 * a payload id reused against a different target or injected string is rejected.
 */
export function createAppDeliveryAdapter(deps: AppDeliveryDeps): DeliverFn {
  const resolved = {
    focusWindow: deps.focusWindow ?? focusAppWindow,
    writeImageToClipboard: deps.writeImageToClipboard,
    writeTextToClipboard: deps.writeTextToClipboard,
    simulatePaste: deps.simulatePaste,
    sendKeys: deps.sendKeys,
    delay: deps.delay ?? defaultDelay,
    pathExists: deps.pathExists ?? defaultPathExists,
    readTextFile: deps.readTextFile ?? defaultReadTextFile,
  };
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
        return Promise.resolve({
          kind: "failed",
          code: "delivery-id-mismatch",
          message: safeMessageFor("delivery-id-mismatch"),
        });
      }
      return existing.outcome;
    }

    const outcome = runAppDelivery(resolved, payload, target);
    ledger.set(payload.id, {
      injectText: payload.injectText,
      target: target.target,
      outcome,
    });
    return outcome;
  };
}

/**
 * Dispatches a delivery to the app adapter for a `kind:"app"` target, and to the
 * Herdr adapter otherwise (absent/"herdr"). The single seam that keeps the send
 * session ignorant of what a target IS.
 */
export function createRoutingDeliveryAdapter(adapters: {
  readonly herdr: DeliverFn;
  readonly app: DeliverFn;
}): DeliverFn {
  return (payload, target) =>
    target.kind === "app"
      ? adapters.app(payload, target)
      : adapters.herdr(payload, target);
}

type ResolvedAppDeps = {
  focusWindow: (view: AppTargetView) => Promise<AppWindowOutcome>;
  writeImageToClipboard: (pngPath: string) => void;
  writeTextToClipboard: (text: string) => void;
  simulatePaste: () => Promise<void>;
  sendKeys?: (keys: string) => Promise<void>;
  delay: (ms: number) => Promise<void>;
  pathExists: (filePath: string) => Promise<boolean>;
  readTextFile: (filePath: string) => Promise<string>;
};

async function runAppDelivery(
  deps: ResolvedAppDeps,
  payload: SendPayload,
  target: EligibleTarget,
): Promise<CaptureDeliverOutcome> {
  const view = target.app;
  if (!view) {
    // The router only sends kind:"app" here, and those always carry `app` —
    // but never paste blind on a malformed target.
    return {
      kind: "failed",
      code: "app-focus-failed",
      message: appFocusFailedMessage(target.label),
    };
  }

  // 1. Preconditions — a payload that names a file must have it before we touch
  //    the clipboard (mirrors deliver.ts; a bad path must never reach the app).
  if (payload.requiresFile !== undefined) {
    if (!(await deps.pathExists(payload.requiresFile))) {
      return {
        kind: "failed",
        code: "delivery-file-missing",
        message: safeMessageFor("delivery-file-missing"),
      };
    }
  }
  for (const filePath of payload.requiresFiles ?? []) {
    if (!(await deps.pathExists(filePath))) {
      return {
        kind: "failed",
        code: "delivery-file-missing",
        message: missingFileMessage(path.win32.basename(filePath)),
      };
    }
  }

  // 2. Choose clipboard content from the payload's flavor (SendPayload speaks a
  //    Herdr-shaped "inject a string / require a file" vocabulary, so recover
  //    the flavor by extension — the #73 bridge). Written BEFORE focus.
  const requires = payload.requiresFile;
  if (requires && isImagePath(requires)) {
    deps.writeImageToClipboard(requires);
  } else if (requires && isTextSpillPath(requires)) {
    // A long-text Relay spilled to a .txt: paste its CONTENTS, never its path —
    // ChatGPT can't `Read` a local path the way a coding agent can.
    deps.writeTextToClipboard(await deps.readTextFile(requires));
  } else {
    deps.writeTextToClipboard(payload.injectText);
  }

  // 3. Focus — for an app target, focus IS the delivery mechanism, so a failure
  //    fails the delivery (never paste into the wrong window).
  const focus = await deps.focusWindow(view);
  if (focus.kind !== "focused") {
    return focusFailure(view.label, focus);
  }

  // 4. Focus-settle (#99) — "the window is foreground" is not "the composer has
  //    the cursor" for a webview app: it foregrounds first, then routes input a
  //    beat later. Wait for that beat so Ctrl+V doesn't land in the gap and
  //    no-op. Only reached on focus success — a failed focus has no paste to
  //    settle for. Per-target `pasteDelayMs` overrides the default.
  await deps.delay(view.pasteDelayMs ?? DEFAULT_PASTE_SETTLE_MS);

  // 5. Optional composer-focus keystroke before the paste.
  if (view.pasteFocusKeys && deps.sendKeys) {
    await deps.sendKeys(view.pasteFocusKeys);
  }

  // 6. Paste — Ctrl+V, no Enter.
  await deps.simulatePaste();
  return { kind: "delivered" };
}

function focusFailure(
  label: string,
  outcome: AppWindowOutcome,
): CaptureDeliverOutcome {
  if (outcome.kind === "window-not-found") {
    return { kind: "failed", code: "app-window-not-found", message: appNotOpenMessage(label) };
  }
  if (outcome.kind === "foreground-refused") {
    return { kind: "failed", code: "app-foreground-refused", message: appRefusedMessage(label) };
  }
  // helper-not-found | helper-error
  return { kind: "failed", code: "app-focus-failed", message: appFocusFailedMessage(label) };
}

/** Dynamic, label-carrying messages — the label can't live in a static map. Never a raw error. */
function appNotOpenMessage(label: string): string {
  return `${label} isn't open — nothing to paste into, sir.`;
}
function appRefusedMessage(label: string): string {
  return `${label} wouldn't come forward — try again, sir.`;
}
function appFocusFailedMessage(label: string): string {
  return `Couldn't reach ${label} — try again, sir.`;
}

function isImagePath(filePath: string): boolean {
  return /\.png$/i.test(filePath);
}
function isTextSpillPath(filePath: string): boolean {
  return /\.txt$/i.test(filePath);
}
