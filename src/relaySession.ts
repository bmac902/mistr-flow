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
  buildRelayCopyKeptOverlaySnapshot,
  buildRelayDeliveringOverlaySnapshot,
  buildRelayNothingToSendOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";

/**
 * Which delivering prop the mascot carries for a given payload: a folded note
 * for short inline text, the ledger for spilled text, a framed portrait for an
 * image. Inline text has no `requiresFile`/`requiresFiles`; a spill/file(s)/
 * image payload declares one or the other — and only the image is the "image"
 * artifact kind, so the three fall out cleanly from what's already on the
 * artifact. A multi-select (#67) is `requiresFiles`, so it's the ledger: a
 * path-injecting payload, per #41's mapping.
 */
function relayPayloadKind(
  artifact: RelayArtifact,
): "note" | "ledger" | "portrait" {
  if (artifact.kind === "image") return "portrait";
  const { requiresFile, requiresFiles } = artifact.payload;
  return requiresFile !== undefined || requiresFiles !== undefined
    ? "ledger"
    : "note";
}

// Relay verb — the clipboard as a source, wired end to end (issue #39, PRD #24).
// Copy something → hotkey → the picker previews what you're about to send →
// press a digit → it lands in that agent's input box, unsent, for you to add
// context and submit yourself. This kills the Ctrl+C → Alt+Tab → find the pane
// → Ctrl+V dance for copied code, stack traces, URLs, and terminal output.
//
// This is deliberately a THIN wrapper around the shared send session (#37): it
// reads + classifies the clipboard (#38), handles the one state the shared
// loop has no concept of (an empty clipboard), and otherwise hands the
// picker → select → deliver loop straight to runSendSession. Relay differs
// from Capture only in what flows — not in the machinery, so it forks none of
// it. Slot 1 is "1 Clipboard" = keep the copy, stop here (issue #64): with
// copy-selection-first on (a main.ts concern — this session never sees the
// flag), Ctrl+Alt+C already performed the copy before the picker opened, so
// slot 1 is the affirmative local ending — select → hotkey → 1 replaces plain
// Ctrl+C while 2–9 still reach the panes.

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
  /**
   * Slot 1: the copy was kept — the affirmative local ending (issue #64).
   * Distinct from a bare `clipboard-delivered` in logs, mirroring Herald's
   * `pasted-here` mapping: slot 1 delivered nothing anywhere, it stopped here.
   */
  | { readonly kind: "copy-kept" }
  | Exclude<RunCaptureSessionResult, { kind: "clipboard-delivered" }>;

/**
 * Herdr-down copy for Relay. With slot 1 returned (#64), a down Herdr degrades
 * to "Clipboard + Esc" exactly like Capture — the copy is already safe on the
 * clipboard, and the message says so. Never "nowhere to send it" (false now),
 * and never Herdr's own "— Clipboard only, sir." messages: Relay's slot 1
 * keeps a copy rather than making one, so it words the fallback itself.
 */
export const RELAY_HERDR_DOWN_MESSAGE =
  "Herdr isn't answering — your copy is safe on the clipboard, sir.";

/** Herdr is up, but has no agent pane to offer — the copy is still safe. */
export const RELAY_NO_PANES_MESSAGE =
  "No agent panes open — your copy is on the clipboard, sir.";

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

  const result = await runSendSession<RelayArtifact>({
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
    // Slot 1 (issue #64): "1 Clipboard" = keep the copy, stop here. No
    // slotOneLabel — the renderer's "Clipboard" default, byte-identical to
    // Capture's — and no clipboard-write dependency at all: the content is
    // already on the clipboard (the user's own Ctrl+C, or the copy main.ts
    // performed before this session opened), whatever the source kind, so
    // writing anything here could only clobber it — a relayed image would be
    // re-encoded over itself. Slot 1 writes nothing.
    clipboardSlot: true,
    clipboardDeliveredSnapshot: () => buildRelayCopyKeptOverlaySnapshot(),
    again: deps.again,
    clock: deps.clock,
    paneQueryTimeoutMs: deps.paneQueryTimeoutMs,
    deliveryAckTimeoutMs: deps.deliveryAckTimeoutMs,
  });

  // The kept-copy ending gets its own result kind for logs (Herald's
  // pasted-here precedent): "clipboard-delivered" would read as a write that
  // never happened — slot 1 kept the copy, it delivered nothing.
  if (result.kind === "clipboard-delivered") {
    return { kind: "copy-kept" };
  }
  return result;
}

function toRelayArtifact(
  source: Extract<ClipboardSource, { kind: "text" | "image" | "file" | "files" }>,
): RelayArtifact {
  // A copied file rides the text branch: like text it is preview + payload with
  // nothing to crop — its payload just happens to inject a path rather than a
  // body, which delivery already handles (spill files do exactly this). A
  // multi-select (#67) rides it identically: its preview is the same text
  // shape (full paths, one per line) and its payload injects the newline-
  // joined block, which bracketed-paste already delivers atomically.
  if (source.kind === "text" || source.kind === "file" || source.kind === "files") {
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
 * non-empty target list becomes Relay's own truthful message — the copy is
 * safe on the clipboard, and slot 1 stays usable through all of them (#64) —
 * so the picker never sticks on the "summoning…" beat. Herdr's "— Clipboard
 * only" messages are still never repeated: Relay's slot 1 *keeps* a copy
 * rather than making one, so Relay words the fallback itself. The
 * `incompatible` message is actionable and promises nothing, so it is kept
 * verbatim. The synthesized `code` for the no-panes case is internal only:
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
