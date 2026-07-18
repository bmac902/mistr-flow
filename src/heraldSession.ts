import {
  runSendSession,
  type CaptureDeliverOutcome,
  type CapturePickerHandle,
  type CaptureSessionClock,
  type SameAgentAgainDependency,
} from "./captureSession";
import type { ClipboardTextPreview } from "./captureThumbnail";
import { buildTextSummary, CLIPBOARD_PREVIEW_LINES } from "./clipboardSource";
import type { SendPayload } from "./deliver";
import {
  runDictationFrontHalf,
  type DictationCancelReason,
} from "./dictation";
import type { EligibleTarget, HerdrQueryResult } from "./herdr";
import {
  buildErrorOverlaySnapshot,
  buildOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";

// Herald verb — voice routed to an agent pane (issue #55, ADR 0003). A press
// of Ctrl+Alt+H runs dictation's front half (record → transcribe → Polish) and
// routes the polished text through the SAME send session Capture and Relay use,
// instead of pasting locally. Voice's front half joined to Relay's back half:
// no new plumbing, and no new mascot art — Herald composes dictation's
// listening/recording/polishing beats with the send session's
// picker/delivering/delivered beats.
//
// The governing principle (ADR 0003): voice never sends silently. Voice is the
// only input with no visual record — you never see what Whisper heard — so the
// Polished transcript rides the picker's read-only text preview, and choosing
// a target IS the confirm-and-send. If the transcript is wrong, Esc
// re-dictates: the picker dismiss loops straight back into a fresh recording.

/** Slot 1's picker entry: paste the polished text into the focused window. */
export const HERALD_SLOT_ONE_LABEL = "Paste here";

/**
 * Herdr-down / no-panes copy for Herald. Herald's slot 1 ("Paste here")
 * survives every Herdr failure, so the dictation is never lost. The copy says
 * so; never Herdr's own "— Clipboard only, sir." messages, which name a slot
 * Herald doesn't have. (Relay's slot 1 survives the same failures since #64,
 * with its own copy-is-safe wording — see relaySession.ts.)
 */
export const HERALD_HERDR_DOWN_MESSAGE =
  "Herdr isn't answering — I can still paste it here, sir.";

/** Herdr is up, but has no agent pane to offer — slot 1 still works. */
export const HERALD_NO_PANES_MESSAGE =
  "No agent panes open — I can still paste it here, sir.";

/** The preview's kind label for a cleanly Polished transcript. */
export const HERALD_POLISHED_LABEL = "Polished";

/**
 * The preview's kind label when Polish failed after transcription succeeded.
 * Spoken words are never lost (CONTEXT.md), so the RAW transcript rides the
 * preview instead — and the label says so, right where the eyes already are.
 * This is a Polish *failure* fallback, not a raw-transcript mode: Polish
 * always ran (ADR 0003 decision 2).
 */
export const HERALD_RAW_FALLBACK_LABEL = "Raw — Polish tripped";

/**
 * What flows through the shared send loop for Herald: the utterance's text,
 * its inline {@link SendPayload}, and the read-only transcript preview (the
 * Relay text-preview slot). Always inline text — a dictated utterance is
 * nowhere near the clipboard spill threshold, and there is never a file.
 */
export interface HeraldArtifact {
  readonly text: string;
  readonly payload: SendPayload;
  readonly preview: ClipboardTextPreview;
}

export type RunHeraldSessionResult =
  /** Recording aborted (Esc or the dead-zone debounce) — nothing was sent. */
  | { readonly kind: "cancelled"; readonly reason: DictationCancelReason }
  /** Transcription failed — there was never text to route. */
  | { readonly kind: "hard-error"; readonly error: Error }
  /** Slot 1: the polished text was pasted into the focused window (the Ctrl+Alt+D outcome). */
  | { readonly kind: "pasted-here" }
  | { readonly kind: "target-delivered"; readonly target: EligibleTarget }
  | {
      readonly kind: "delivery-failed";
      readonly target: EligibleTarget;
      readonly code: string;
      readonly message: string;
    };

export interface RunHeraldSessionDependencies {
  showOverlay(snapshot: OverlaySnapshot): void | Promise<void>;
  playBeep(): void | Promise<void>;
  /**
   * One fresh recording per call — Esc in the picker re-dictates (ADR 0003),
   * so a single Herald session may record several times. Rejects with a
   * DictationCancelledError on Esc/dead-zone, exactly as dictation's does.
   */
  recordAudio(): Promise<Buffer>;
  transcribe(audioBuffer: Buffer): Promise<string>;
  polish(rawTranscript: string): Promise<string>;
  openPicker(): CapturePickerHandle;
  queryEligibleTargets(): Promise<HerdrQueryResult>;
  deliver(payload: SendPayload, target: EligibleTarget): Promise<CaptureDeliverOutcome>;
  /**
   * Slot 1's salvage: paste `text` into the focused window — clipboard write
   * plus the simulated Ctrl+V, exactly what Ctrl+Alt+D would have done. Fire
   * H when you meant D, tap 1, and the utterance isn't re-spoken (ADR 0003).
   */
  pasteHere(text: string): Promise<void> | void;
  /** Mints the payload id — one per utterance, so the delivery ledger keys correctly. */
  mintId(): string;
  /** Same agent again (issue #58): the shared Last Target, passed straight through. */
  again?: SameAgentAgainDependency;
  clock?: CaptureSessionClock;
  paneQueryTimeoutMs?: number;
  deliveryAckTimeoutMs?: number;
}

export async function runHeraldSession(
  deps: RunHeraldSessionDependencies,
): Promise<RunHeraldSessionResult> {
  // Esc in the picker loops back here — "re-dictates" means exactly that: a
  // wrong transcript costs one keypress and a re-take, never a lost utterance
  // routed anyway or a dead end. Esc *while recording* still aborts outright
  // (the front half's cancelled path), so the loop always has an exit.
  for (;;) {
    const front = await runDictationFrontHalf({
      showOverlay: deps.showOverlay,
      playBeep: deps.playBeep,
      recordAudio: deps.recordAudio,
      transcribe: deps.transcribe,
      polish: deps.polish,
    });

    if (front.kind === "cancelled") {
      // The front half already showed the cancelled beat.
      return front;
    }

    if (front.kind === "hard-error") {
      // Transcription failed: there is nothing to route. Same beat as
      // dictation's hard error — nothing was heard, nothing is faked.
      void deps.showOverlay(buildErrorOverlaySnapshot(front.error.message));
      return front;
    }

    // Polish always ran. On a Polish FAILURE the raw transcript rides the
    // preview instead of being lost — the read-only preview is exactly the
    // defense for text about to reach a live agent, and its summary line
    // names the fallback (spoken words are never silently lost, CONTEXT.md).
    const text =
      front.kind === "polished" ? front.polishedText : front.rawTranscript;
    const artifact = buildHeraldArtifact(
      text,
      deps.mintId(),
      front.kind === "polished",
    );

    const sendResult = await runSendSession<HeraldArtifact>({
      showOverlay: deps.showOverlay,
      // The utterance was recorded and Polished above; the shared loop's
      // "grab" hands back what voice already produced. It never fails — the
      // cancel/error outcomes were decided before the session opened.
      captureActiveWindow: async () => artifact,
      openPicker: deps.openPicker,
      renderThumbnail: (a) => Promise.resolve(a.preview),
      // No cropCapture: there is nothing to crop on a transcript, and
      // in-overlay editing was explicitly rejected for v1 (ADR 0003).
      queryEligibleTargets: () =>
        deps.queryEligibleTargets().then(toHeraldQueryResult),
      // The shared loop's OWN synthesized pane-query-timeout result bypasses
      // the wrapped queryEligibleTargets above (issue #87): its outer deadline
      // races the query and, on a slow Herdr, resolves first with Herdr's raw
      // "— Clipboard only, sir." wording — a slot Herald doesn't have. The
      // same remap applies here so that invariant holds on this deadline too.
      mapQueryTimeoutResult: toHeraldQueryResult,
      copyToClipboard: (a) => deps.pasteHere(a.text),
      // Slot 1's outcome beat is dictation's own `done` ("Pasted, sir.") —
      // it IS the Ctrl+Alt+D outcome, and no new mascot art (ADR 0003).
      clipboardDeliveredSnapshot: () => buildOverlaySnapshot("done"),
      clipboardSlot: true,
      slotOneLabel: HERALD_SLOT_ONE_LABEL,
      deliver: (a, target) => deps.deliver(a.payload, target),
      again: deps.again,
      clock: deps.clock,
      paneQueryTimeoutMs: deps.paneQueryTimeoutMs,
      deliveryAckTimeoutMs: deps.deliveryAckTimeoutMs,
    });

    if (sendResult.kind === "cancelled") continue; // Esc re-dictates.

    if (sendResult.kind === "clipboard-delivered") {
      return { kind: "pasted-here" };
    }
    if (sendResult.kind === "capture-failed") {
      // Unreachable: Herald's grab hands back pre-built text and never throws.
      return { kind: "hard-error", error: new Error(sendResult.message) };
    }
    return sendResult;
  }
}

/**
 * Wraps an utterance's text as the send loop's artifact: an inline text
 * payload (no file — `deliver` brackets multi-line bodies itself) plus the
 * read-only preview riding the Relay text-preview slot.
 */
export function buildHeraldArtifact(
  text: string,
  id: string,
  polished: boolean,
): HeraldArtifact {
  const lines = text.split("\n");
  return {
    text,
    payload: { id, injectText: text },
    preview: {
      kind: "text",
      firstLines: lines.slice(0, CLIPBOARD_PREVIEW_LINES).join("\n"),
      truncated: lines.length > CLIPBOARD_PREVIEW_LINES,
      lineCount: lines.length,
      byteSize: Buffer.byteLength(text, "utf8"),
      spilled: false,
      summary: buildTextSummary(
        polished ? HERALD_POLISHED_LABEL : HERALD_RAW_FALLBACK_LABEL,
        lines.length,
        Buffer.byteLength(text, "utf8"),
        false,
      ),
    },
  };
}

/**
 * Maps Herdr's query result into Herald's picker states. Anything that isn't a
 * non-empty target list becomes Herald's own truthful message — slot 1 ("Paste
 * here") stays live through all of them, so the dictation is never lost and
 * the picker never sticks on the "summoning…" beat. Herdr's "— Clipboard
 * only" messages are never repeated: they name a slot Herald doesn't have.
 * The `incompatible` message is actionable and promises nothing, so it is
 * kept verbatim (same reasoning as Relay's). The synthesized `code` for the
 * no-panes case is internal only: the session renders the message, never the
 * code.
 */
function toHeraldQueryResult(result: HerdrQueryResult): HerdrQueryResult {
  if (result.kind === "targets") {
    if (result.targets.length > 0) return result;
    return {
      kind: "failed",
      code: "pane-query-failed",
      message: HERALD_NO_PANES_MESSAGE,
    };
  }
  if (result.kind === "incompatible") {
    return result;
  }
  return { ...result, message: HERALD_HERDR_DOWN_MESSAGE };
}
