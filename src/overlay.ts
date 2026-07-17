import type { PickerPreview } from "./captureThumbnail";
import type { EligibleTarget } from "./herdr";
import type { FleetTier } from "./fleetState";

export type OverlayPhase =
  | "idle"
  | "listening"
  | "recording"
  | "cancelled"
  | "processing"
  | "polishing"
  | "done"
  | "error"
  | "refused"
  | "capture-picker"
  | "capture-delivering"
  | "capture-delivered"
  | "capture-delivery-failed"
  | "capture-delivery-unknown"
  /** Capture: a crop drag is in progress on the preview — the mascot appraises it. */
  | "capture-framing"
  /** Relay: the clipboard was empty — nothing to send, no target picker. */
  | "relay-nothing-to-send"
  /** Relay: Herdr is unreachable — he's holding it, but there's nowhere to give it. */
  | "relay-no-destination"
  /** Relay: delivering, with a payload-specific prop (see relayPayloadKind). */
  | "relay-delivering"
  | "relay-delivered"
  /** Relay: delivered, but the pane was mid-turn — landed as text, not an attachment. */
  | "relay-delivered-busy"
  /**
   * Fleet awareness (PRD #44): the resting bar's ambient posture, one per
   * blocked-count tier plus the honest "can't see the fleet" state. Rendered at
   * idle only. Tier 0 has its own calm "perfectly relaxed" posture (distinct
   * from plain `idle`, which still shows before the first fleet poll resolves).
   * The bespoke butler postures come from Claude Design (#53), integrated
   * verbatim into the overlay markup.
   */
  | "fleet-unknown"
  | "fleet-0-blocked"
  | "fleet-1-blocked"
  | "fleet-2-3-blocked"
  | "fleet-4-plus-blocked";

/**
 * The picker's "⟲ again" row (issue #58, ADR 0004): the fast path to the
 * shared Last Target, keyed to the verb's own hotkey — never a digit. It
 * renders from the in-memory record on the picker's FIRST frame (pane entries
 * wait out the query; this row must not), then reconciles when the query
 * lands: still present → label refreshed, `state: "live"`; gone →
 * `state: "unmarked"` — visibly, never silently removed.
 */
export interface PickerAgainRow {
  /** The remembered pane's human label (refreshed once the query confirms it). */
  readonly label: string;
  /** The verb's own hotkey, as shown on the row (e.g. "Ctrl+Alt+C"). */
  readonly hotkeyLabel: string;
  readonly state: "live" | "unmarked";
}

export interface OverlaySnapshot {
  phase: OverlayPhase;
  barMode: "peek" | "expanded";
  waveformVisible: boolean;
  mascotCopy: string;
  statusCopy: string;
  toastCopy?: string;
  /** Eligible-target entries for the picker; panes always sit on digits 2–9. */
  captureTargets?: readonly EligibleTarget[];
  /** True only during the brief pre-target "summoning" sub-beat of the picker. */
  pickerSummoning?: boolean;
  /**
   * Whether digit slot 1 renders the pinned local outcome. True for every verb
   * since #64 — slot 1 is always "end this locally, no pane": Capture copies
   * the grab, Relay keeps the copy Ctrl+Alt+C already made, Herald pastes here
   * (CONTEXT.md, "Slot 1 is the local outcome in every verb"). Panes occupy
   * 2–9 either way; `false` remains renderable but no verb passes it today.
   */
  clipboardSlot?: boolean;
  /**
   * What slot 1's entry reads when it isn't Capture's "Clipboard": Herald's
   * slot 1 is "Paste here" — the polished transcript into the focused window,
   * the Ctrl+Alt+D outcome, kept as a salvage (ADR 0003). Only meaningful when
   * `clipboardSlot` is true; absent means the renderer's "Clipboard" default.
   */
  slotOneLabel?: string;
  /**
   * Preview of what the picker is about to send (issue #35/#39) — picker phase
   * only, so it never leaks into the delivering/delivered/failed beats. An
   * image thumbnail for a capture/relayed image, a text head for relayed text.
   * Absent when rendering failed: the picker renders fine without it.
   */
  capturePreview?: PickerPreview;
  /**
   * Rides capture-picker / relay-delivering as a modifier: the clipboard text
   * spilled to a file, so the mascot lugs the ledger rather than a note
   * (CONTEXT.md — the ledger is a modifier, not a state of its own).
   */
  ledgerSpill?: boolean;
  /** Which prop relay-delivering shows: a folded note, the ledger, or a framed portrait. */
  relayPayloadKind?: "note" | "ledger" | "portrait";
  /**
   * Same agent again (issue #58, ADR 0004): the "⟲ again" picker row for the
   * shared Last Target. Absent when no Last Target exists (fresh launch) —
   * then there is no row and the verb-key confirm is a truthful no-op.
   */
  againRow?: PickerAgainRow;
  /**
   * Done-awareness ambient half (ADR 0006 §5, PRD #77 / #81): how many watched
   * panes are currently *done* — the badge that answers "what have you finished?"
   * while the butler's posture keeps answering "who needs you?". Rides only the
   * idle fleet-posture snapshots, so the badge is idle-only by construction; the
   * renderer draws a plain count chip when this is ≥ 1 and nothing when 0 or
   * absent. Structurally independent of {@link phase} — done never moves the
   * bottleneck tier.
   */
  doneCount?: number;
}

const STATUS_COPY: Record<OverlayPhase, string> = {
  idle: "Ready when you are, sir.",
  listening: "Listening…",
  recording: "Go on, I’m taking notes…",
  cancelled: "Very well. We shall pretend that never happened.",
  processing: "Tidying your ramble…",
  polishing: "Ahem. Much better…",
  done: "Pasted, sir.",
  error: "Mistr Flo tripped over the microphone.",
  refused: "One thing at a time, sir.",
  "capture-picker": "Pick your target, sir.",
  "capture-delivering": "Delivering to the pane…",
  "capture-delivered": "Delivered, sir.",
  "capture-delivery-failed": "That pane didn't take it.",
  "capture-delivery-unknown": "Not sure that landed — try again?",
  "capture-framing": "Say when, sir.",
  "relay-nothing-to-send": "Your pockets are empty, sir.",
  "relay-no-destination": "I have it, sir. There's no one to give it to.",
  "relay-delivering": "Delivering to the pane…",
  "relay-delivered": "Delivered, sir.",
  "relay-delivered-busy": "Delivered, sir — though he's rather engrossed.",
  "fleet-unknown": "I don't actually know, sir.",
  "fleet-0-blocked": "Whenever you're ready, sir.",
  "fleet-1-blocked": "One moment requires you, sir.",
  "fleet-2-3-blocked": "A few matters await, sir.",
  "fleet-4-plus-blocked": "Sir… we have accumulated some matters.",
};

/** relay-delivering's status line names what's being carried — see relayPayloadKind. */
const RELAY_DELIVERING_PAYLOAD_COPY: Record<"note" | "ledger" | "portrait", string> = {
  note: "Conveying your note, sir…",
  ledger: "Still conveying that ledger, sir…",
  portrait: "Conveying the portrait, sir…",
};

const SUMMONING_STATUS_COPY = "Summoning targets…";

const MASCOT_COPY: Record<OverlayPhase, string> = {
  idle: "hat + eyes",
  listening: "tips top hat",
  recording: "moustache wiggle",
  cancelled: "exits stage left",
  processing: "cane twirl",
  polishing: "brushes sentence ribbon",
  done: "top hat bow",
  error: "top hat askew",
  refused: "wags a scolding finger",
  "capture-picker": "counts on gloved fingers",
  "capture-delivering": "leans toward the pane",
  "capture-delivered": "tips hat toward the pane",
  "capture-delivery-failed": "hat droops",
  "capture-delivery-unknown": "tilts head, puzzled",
  "capture-framing": "raises a monocle to appraise the crop",
  "relay-nothing-to-send": "pats his pockets, finds nothing",
  "relay-no-destination": "taps the bell at an empty desk",
  "relay-delivering": "leans toward the pane",
  "relay-delivered": "tips hat toward the pane",
  "relay-delivered-busy": "tips hat, glances sideways at a busy pane",
  "fleet-unknown": "checks his pocket watch, glancing around",
  "fleet-0-blocked": "perfectly relaxed",
  "fleet-1-blocked": "turns and looks toward you",
  "fleet-2-3-blocked": "upright, a folder in hand",
  "fleet-4-plus-blocked": "one hand behind his back, a stack of folders in the other",
};

export interface HappyPathOverlayDependencies {
  showOverlay(snapshot: OverlaySnapshot): void | Promise<void>;
  playBeep(): void | Promise<void>;
  recordAudio(): Promise<Buffer>;
  transcribe(audioBuffer: Buffer): Promise<string>;
  polish(rawTranscript: string): Promise<string>;
  pasteText(text: string): Promise<void> | void;
}

export function buildOverlaySnapshot(phase: OverlayPhase): OverlaySnapshot {
  switch (phase) {
    case "idle":
      return {
        phase,
        barMode: "peek",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "listening":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: true,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "recording":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: true,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "cancelled":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "processing":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "polishing":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "done":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "error":
      return buildErrorOverlaySnapshot();
    case "refused":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "capture-picker":
      return buildCapturePickerOverlaySnapshot([]);
    case "capture-delivering":
    case "capture-delivered":
    case "capture-delivery-unknown":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "capture-delivery-failed":
      return buildCaptureDeliveryFailedOverlaySnapshot();
    case "capture-framing":
    case "relay-nothing-to-send":
    case "relay-no-destination":
    case "relay-delivered":
    case "relay-delivered-busy":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
    case "relay-delivering":
      return buildRelayDeliveringOverlaySnapshot("note");
    case "fleet-unknown":
    case "fleet-0-blocked":
    case "fleet-1-blocked":
    case "fleet-2-3-blocked":
    case "fleet-4-plus-blocked":
      // A posture is an expression of the *resting* bar, so it stays in peek —
      // the bar never grows to reflect fleet state (PRD: "never steal focus /
      // stay out of the way exactly as it does today").
      return {
        phase,
        barMode: "peek",
        waveformVisible: false,
        mascotCopy: MASCOT_COPY[phase],
        statusCopy: STATUS_COPY[phase],
      };
  }
}

/**
 * Map an ambient fleet tier to the overlay phase that renders it. Every tier —
 * including the calm tier `0` ("perfectly relaxed") — has its own bespoke butler
 * posture from Claude Design (#53). Plain `idle` still shows before the first
 * fleet poll resolves; once it does, tier 0 swaps to its distinct resting bar.
 */
export function fleetTierToOverlayPhase(tier: FleetTier): OverlayPhase {
  switch (tier) {
    case "0":
      return "fleet-0-blocked";
    case "1":
      return "fleet-1-blocked";
    case "2-3":
      return "fleet-2-3-blocked";
    case "4+":
      return "fleet-4-plus-blocked";
    case "unknown":
      return "fleet-unknown";
  }
}

/**
 * The idle-time overlay snapshot for a given fleet tier, carrying the current
 * done-pane count for the ambient badge (ADR 0006 §5). `doneCount` is attached
 * *beside* the tier-driven phase, never folded into it — the butler's posture
 * stays a pure function of Blocked. Zero renders no chip (the renderer's job).
 */
export function buildFleetPostureOverlaySnapshot(
  tier: FleetTier,
  doneCount = 0,
): OverlaySnapshot {
  return { ...buildOverlaySnapshot(fleetTierToOverlayPhase(tier)), doneCount };
}

/**
 * The picker phase covers both the two-phase-render "summoning" beat (no
 * targets yet, no message) and the populated/local-only states — same
 * phase, different copy, so a late Herdr response only ever changes copy,
 * never resurrects a closed picker.
 */
export function buildCapturePickerOverlaySnapshot(
  targets: readonly EligibleTarget[],
  message?: string,
  preview?: PickerPreview | null,
  clipboardSlot = true,
  slotOneLabel?: string,
  againRow?: PickerAgainRow,
): OverlaySnapshot {
  const summoning = targets.length === 0 && message === undefined;
  return {
    phase: "capture-picker",
    barMode: "expanded",
    waveformVisible: false,
    mascotCopy: MASCOT_COPY["capture-picker"],
    statusCopy: summoning ? SUMMONING_STATUS_COPY : STATUS_COPY["capture-picker"],
    toastCopy: message,
    captureTargets: targets,
    pickerSummoning: summoning,
    clipboardSlot,
    slotOneLabel,
    capturePreview: preview ?? undefined,
    againRow,
  };
}

/**
 * The Relay "nothing to send" beat: the clipboard was empty, so there is no
 * target picker at all — a truthful, un-faded state, not a misleading success
 * (CONTEXT.md — Relay never fakes a send). He pats his pockets and finds
 * nothing. Distinct from the Herdr-down state: there he's holding something
 * (safe on the clipboard, slot 1 usable — #64), here he has nothing.
 */
export function buildRelayNothingToSendOverlaySnapshot(): OverlaySnapshot {
  return {
    phase: "relay-nothing-to-send",
    barMode: "expanded",
    waveformVisible: false,
    mascotCopy: MASCOT_COPY["relay-nothing-to-send"],
    statusCopy: STATUS_COPY["relay-nothing-to-send"],
  };
}

/** Relay slot 1 (issue #64): the kept-copy success beat's status line. */
export const RELAY_COPY_KEPT_STATUS_COPY =
  "Copied, sir — it's on your clipboard.";

/**
 * Relay's slot-1 ending (issue #64): "1 Clipboard" = keep the copy, stop here.
 * An affirmative local ending — a success beat, never the cancelled beat Esc
 * gives — so it reuses dictation's existing `done` phase (top hat bow;
 * Herald's slot-1 precedent) with Relay-specific status copy naming the
 * outcome. No new mascot states or art; `done` already sits in main.ts's
 * window-restore set, so the picker-grown window shrinks back on it.
 */
export function buildRelayCopyKeptOverlaySnapshot(): OverlaySnapshot {
  return {
    ...buildOverlaySnapshot("done"),
    statusCopy: RELAY_COPY_KEPT_STATUS_COPY,
  };
}

/**
 * Relay delivering, with the prop that matches what's being carried: a folded
 * note for short inline text, the ledger for spilled text, a framed portrait
 * for an image. The status line names it too, so the payload is legible whether
 * you're watching the mascot or reading the copy.
 */
export function buildRelayDeliveringOverlaySnapshot(
  payloadKind: "note" | "ledger" | "portrait",
): OverlaySnapshot {
  return {
    phase: "relay-delivering",
    barMode: "expanded",
    waveformVisible: false,
    mascotCopy: MASCOT_COPY["relay-delivering"],
    statusCopy: RELAY_DELIVERING_PAYLOAD_COPY[payloadKind],
    relayPayloadKind: payloadKind,
    ledgerSpill: payloadKind === "ledger",
  };
}

export function buildCaptureDeliveryFailedOverlaySnapshot(
  message?: string,
): OverlaySnapshot {
  return {
    phase: "capture-delivery-failed",
    barMode: "expanded",
    waveformVisible: false,
    mascotCopy: MASCOT_COPY["capture-delivery-failed"],
    statusCopy: STATUS_COPY["capture-delivery-failed"],
    toastCopy: message,
  };
}

export function buildErrorOverlaySnapshot(
  toastCopy?: string,
): OverlaySnapshot {
  return {
    phase: "error",
    barMode: "expanded",
    waveformVisible: false,
    mascotCopy: MASCOT_COPY.error,
    statusCopy: STATUS_COPY.error,
    toastCopy,
  };
}

export function buildCancelledOverlaySnapshot(): OverlaySnapshot {
  return buildOverlaySnapshot("cancelled");
}

export function buildRefusedOverlaySnapshot(): OverlaySnapshot {
  return buildOverlaySnapshot("refused");
}

export async function runHappyPathOverlaySession(
  dependencies: HappyPathOverlayDependencies,
): Promise<void> {
  void dependencies.showOverlay(buildOverlaySnapshot("listening"));
  void dependencies.playBeep();
  void dependencies.showOverlay(buildOverlaySnapshot("recording"));

  const audioBuffer = await dependencies.recordAudio();
  void dependencies.showOverlay(buildOverlaySnapshot("processing"));

  const rawTranscript = await dependencies.transcribe(audioBuffer);
  void dependencies.showOverlay(buildOverlaySnapshot("polishing"));

  const polishedText = await dependencies.polish(rawTranscript);
  await dependencies.pasteText(polishedText);
  void dependencies.showOverlay(buildOverlaySnapshot("done"));
}
