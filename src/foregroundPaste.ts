import type { CaptureDeliverOutcome } from "./captureSession";

// Bare Ctrl+Alt+V (issue #101): with no picker open, paste the NEWEST
// capture-ring entry into whatever window currently has focus. This is the
// standalone verb's orchestration, kept pure so it is provable without a
// display, a clipboard, or a keyboard — main.ts wires the ring, the
// `kind:"foreground"` delivery adapter, and the overlay beats.
//
// The in-picker twin (arrow to an entry, Ctrl+Alt+V) lives in the shared send
// session instead, because it must settle the OPEN picker; this path settles
// nothing but the resting overlay, so it needs no session.
//
// Two rules mirror the rest of the verb family:
//   - An empty ring is a TRUTHFUL refusal ("nothing captured yet, sir"), never
//     a silent no-op and never a faked "Pasted, sir." (personality is a
//     product property).
//   - The delivery itself is a LOCAL outcome like slot 1: it never updates the
//     shared Last Target (enforced at src/lastTarget.ts, which skips a
//     `kind:"foreground"` target). Nothing here touches that memory.

export interface ForegroundPasteDeps<A> {
  /**
   * The entry to paste — the NEWEST capture-ring entry, or null on an empty
   * ring. Read once, at fire time, so it reflects the newest capture at THIS
   * press. main.ts wires this to `captureHistory.newest`.
   */
  entry(): A | null;
  /**
   * Deliver the entry to the foreground window: write the clipboard by flavor
   * and Ctrl+V, with NO focus step (the foreground already holds focus). Routed
   * through the shared `kind:"foreground"` delivery adapter so a fresh payload
   * id is minted per paste — re-pasting the same entry must actually fire
   * Ctrl+V again, never return the cached ledger outcome (the #95 trap).
   */
  deliver(entry: A): Promise<CaptureDeliverOutcome>;
  /** The truthful empty-ring refusal beat — never a faked success. */
  showNothingCaptured(): void;
  /** The success beat after a foreground paste ("Pasted, sir."). */
  showPasted(): void;
  /** The truthful failure beat when the paste couldn't complete (e.g. the file vanished). */
  showFailed(message: string): void;
}

export type ForegroundPasteResult =
  | { readonly kind: "nothing-captured" }
  | { readonly kind: "pasted" }
  | { readonly kind: "paste-failed"; readonly code: string; readonly message: string };

/**
 * Runs the bare-hotkey foreground paste: read the newest ring entry (empty →
 * truthful refusal), deliver it to the foreground window, then show the pasted
 * beat — or the failure beat if the delivery couldn't complete. A delivery here
 * is synchronous (write clipboard → settle → paste), so it only ever settles
 * `delivered`/`failed`, never the pane-delivery `unknown`; a defensive
 * non-delivered outcome is treated as a failure, never a faked success.
 */
export async function runForegroundPaste<A>(
  deps: ForegroundPasteDeps<A>,
): Promise<ForegroundPasteResult> {
  const entry = deps.entry();
  if (entry === null) {
    deps.showNothingCaptured();
    return { kind: "nothing-captured" };
  }

  const outcome = await deps.deliver(entry);
  if (outcome.kind === "delivered") {
    deps.showPasted();
    return { kind: "pasted" };
  }

  const message =
    outcome.kind === "failed"
      ? outcome.message
      : "Not sure that landed — try again, sir.";
  const code = outcome.kind === "failed" ? outcome.code : "foreground-paste-unknown";
  deps.showFailed(message);
  return { kind: "paste-failed", code, message };
}
