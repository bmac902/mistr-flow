import type { CaptureArtifact } from "./capture";
import type { CropRect } from "./captureCrop";
import {
  runSendSession,
  type CaptureDeliverOutcome,
  type CapturePickerHandle,
  type CaptureSessionClock,
  type RunCaptureSessionResult,
  type SameAgentAgainDependency,
} from "./captureSession";
import type { CapturePreview, ClipboardTextPreview } from "./captureThumbnail";
import type { ClipboardSource } from "./clipboardSource";
import { captureArtifactToPayload, type SendPayload } from "./deliver";
import type { EligibleTarget, HerdrQueryResult } from "./herdr";
import {
  buildOverlaySnapshot,
  buildRelayDeliveringOverlaySnapshot,
  buildRelayNothingToSendOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";

/**
 * Which delivering prop the mascot carries for a given payload: a folded note
 * for short inline text, the ledger for spilled text, a framed portrait for an
 * image. Inline text has no `requiresFile`; a spill/file/image payload does —
 * and only the image is the "image" artifact kind, so the three fall out
 * cleanly from what's already on the artifact.
 */
function relayPayloadKind(
  artifact: RelayArtifact,
): "note" | "ledger" | "portrait" {
  if (artifact.kind === "image") return "portrait";
  return artifact.payload.requiresFile ? "ledger" : "note";
}

// Relay verb — the clipboard as a source, wired end to end (issue #39, PRD #24).
// Copy something → hotkey → the picker previews what you're about to send →
// press a digit → it lands in that agent's input box, unsent, for you to add
// context and submit yourself. This kills the Ctrl+C → Alt+Tab → find the pane
// → Ctrl+V dance for copied code, stack traces, URLs, and terminal output.
//
// This is deliberately a THIN wrapper around the shared send session (#37): it
// reads + classifies the clipboard (#38), handles the two states the shared
// loop has no concept of (an empty clipboard, and Relay's Clipboard-less
// picker), and otherwise hands the picker → select → deliver loop straight to
// runSendSession. Relay differs from Capture only in what flows and in a
// deliberately wasted slot 1 — not in the machinery, so it forks none of it.

/**
 * What flows through the shared loop for Relay. Text carries its inline/spill
 * {@link SendPayload} and a text preview; an image carries a
 * {@link CaptureArtifact}-shaped grab so the existing thumbnail/crop/delivery
 * machinery applies with no new concepts (a clipboard image is the same
 * artifact a screenshot is — CONTEXT.md).
 */
export type RelayArtifact =
  | {
      readonly kind: "text";
      readonly payload: SendPayload;
      readonly preview: ClipboardTextPreview;
    }
  | {
      readonly kind: "image";
      readonly payload: SendPayload;
      readonly artifact: CaptureArtifact;
    };

export type RunRelaySessionResult =
  | { readonly kind: "nothing-to-send" }
  | RunCaptureSessionResult;

/**
 * Herdr-down copy for Relay. Capture degrades to "Clipboard + Esc", but Relay's
 * *source* is the clipboard and its slot 1 is skipped — so there is genuinely
 * nowhere left to offer. Never Herdr's own "— Clipboard only, sir." messages:
 * those promise a fallback Relay does not have (CONTEXT.md).
 */
export const RELAY_HERDR_DOWN_MESSAGE =
  "Herdr isn't answering — nowhere to send it, sir.";

/** Herdr is up, but has no agent pane to send to — still nowhere to send it. */
export const RELAY_NO_PANES_MESSAGE =
  "No agent panes open — nowhere to send it, sir.";

export interface RunRelaySessionDependencies {
  /** Reads + classifies the Windows clipboard once (issue #38). */
  readClipboardSource(): Promise<ClipboardSource>;
  showOverlay(snapshot: OverlaySnapshot): void | Promise<void>;
  openPicker(): CapturePickerHandle;
  /** Best-effort thumbnail for a relayed image; null renders a preview-less picker. */
  renderImageThumbnail(artifact: CaptureArtifact): Promise<CapturePreview | null>;
  /** Crops a relayed image, returning a fresh artifact; null keeps the uncropped one. */
  cropImage(artifact: CaptureArtifact, rect: CropRect): Promise<CaptureArtifact | null>;
  queryEligibleTargets(): Promise<HerdrQueryResult>;
  deliver(payload: SendPayload, target: EligibleTarget): Promise<CaptureDeliverOutcome>;
  /** Same agent again (issue #58): the shared Last Target, passed straight through. */
  again?: SameAgentAgainDependency;
  clock?: CaptureSessionClock;
  paneQueryTimeoutMs?: number;
  deliveryAckTimeoutMs?: number;
}

export async function runRelaySession(
  deps: RunRelaySessionDependencies,
): Promise<RunRelaySessionResult> {
  const source = await deps.readClipboardSource();

  // An empty clipboard renders a truthful "nothing to send" state and never
  // opens a target picker — not a faded flash, not a fake success (CONTEXT.md).
  if (source.kind === "empty") {
    await deps.showOverlay(buildRelayNothingToSendOverlaySnapshot());
    return { kind: "nothing-to-send" };
  }

  const relayArtifact = toRelayArtifact(source);

  return runSendSession<RelayArtifact>({
    showOverlay: deps.showOverlay,
    // The clipboard was already read above; the shared loop's "grab" step just
    // hands back what we classified. It never fails — the empty/read outcomes
    // are decided before the session opens — so no CaptureGrabFailedError path.
    captureActiveWindow: async () => relayArtifact,
    openPicker: deps.openPicker,
    renderThumbnail: (artifact) =>
      artifact.kind === "image"
        ? deps.renderImageThumbnail(artifact.artifact)
        : Promise.resolve(artifact.preview),
    cropCapture: (artifact, rect) =>
      artifact.kind === "image"
        ? cropRelayImage(artifact, rect, deps.cropImage)
        : Promise.resolve(null),
    queryEligibleTargets: () =>
      deps.queryEligibleTargets().then(toRelayQueryResult),
    deliver: (artifact, target) => deps.deliver(artifact.payload, target),
    // Relay's delivering/delivered beats carry the payload-specific prop
    // (note/ledger/portrait) rather than Capture's generic ones (issue #41).
    deliveringSnapshot: (artifact) =>
      buildRelayDeliveringOverlaySnapshot(relayPayloadKind(artifact)),
    // An image delivered into a *working* pane lands as inert text, not an
    // attachment (CONTEXT.md — auto-attach needs an idle agent). Say so: the
    // busy beat glances sideways. Text/paths don't have that caveat, so only
    // an image (portrait) to a working pane earns it.
    deliveredSnapshot: (artifact, target) =>
      relayPayloadKind(artifact) === "portrait" && target.agentStatus === "working"
        ? buildOverlaySnapshot("relay-delivered-busy")
        : buildOverlaySnapshot("relay-delivered"),
    // Slot 1 is skipped for Relay: the clipboard is the source, not a
    // destination — but panes still occupy digits 2–9 (CONTEXT.md).
    clipboardSlot: false,
    again: deps.again,
    clock: deps.clock,
    paneQueryTimeoutMs: deps.paneQueryTimeoutMs,
    deliveryAckTimeoutMs: deps.deliveryAckTimeoutMs,
  });
}

function toRelayArtifact(
  source: Extract<ClipboardSource, { kind: "text" | "image" | "file" }>,
): RelayArtifact {
  // A copied file rides the text branch: like text it is preview + payload with
  // nothing to crop — its payload just happens to inject a path rather than a
  // body, which delivery already handles (spill files do exactly this).
  if (source.kind === "text" || source.kind === "file") {
    return { kind: "text", payload: source.payload, preview: source.preview };
  }
  return { kind: "image", payload: source.payload, artifact: source.artifact };
}

async function cropRelayImage(
  artifact: Extract<RelayArtifact, { kind: "image" }>,
  rect: CropRect,
  cropImage: (
    artifact: CaptureArtifact,
    rect: CropRect,
  ) => Promise<CaptureArtifact | null>,
): Promise<RelayArtifact | null> {
  const cropped = await cropImage(artifact.artifact, rect);
  if (!cropped) return null;
  // A crop is a fresh capture (new id, new path), so the payload is re-derived
  // — the delivery ledger keys idempotency on (id, injectText, target).
  return {
    kind: "image",
    artifact: cropped,
    payload: captureArtifactToPayload(cropped),
  };
}

/**
 * Maps Herdr's query result into Relay's picker states. Anything that isn't a
 * non-empty target list becomes a truthful "nowhere to send it" message so the
 * picker never sticks on the "summoning…" beat — and never repeats Herdr's own
 * "— Clipboard only" messages, which promise a fallback Relay lacks. The
 * `incompatible` message makes no such promise (and is actionable), so it is
 * kept verbatim. The synthesized `code` for the no-panes case is internal only:
 * the session renders the message, never the code.
 */
function toRelayQueryResult(result: HerdrQueryResult): HerdrQueryResult {
  if (result.kind === "targets") {
    if (result.targets.length > 0) return result;
    return {
      kind: "failed",
      code: "pane-query-failed",
      message: RELAY_NO_PANES_MESSAGE,
    };
  }
  if (result.kind === "incompatible") {
    return result;
  }
  return { ...result, message: RELAY_HERDR_DOWN_MESSAGE };
}
