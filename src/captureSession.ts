import type { CaptureArtifact, CaptureFailureCode } from "./capture";
import type { CropRect } from "./captureCrop";
import type { PickerPreview } from "./captureThumbnail";
import type { EligibleTarget, HerdrQueryResult } from "./herdr";
import { PANE_QUERY_TIMEOUT_MS, safeMessageFor as herdrSafeMessageFor } from "./herdr";
import {
  buildCancelledOverlaySnapshot,
  buildCaptureDeliveryFailedOverlaySnapshot,
  buildCapturePickerOverlaySnapshot,
  buildErrorOverlaySnapshot,
  buildOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";

// Capture core tracer (issue #30, PRD #24): `runCaptureSession` mirrors
// `runDictationSession` — a pure async orchestrator over an injected
// dependency bag, with all Electron/PowerShell/Herdr effects confined to
// main-process adapter implementations. No Electron imports here.

/** Deadline for the delivery synchronous ack, beyond which delivery is unknown. */
export const DELIVERY_ACK_TIMEOUT_MS = 3000;

export class CaptureGrabFailedError extends Error {
  readonly code: CaptureFailureCode;

  constructor(code: CaptureFailureCode, message: string) {
    super(message);
    this.name = "CaptureGrabFailedError";
    this.code = code;
  }
}

export function createCaptureGrabFailedError(
  code: CaptureFailureCode,
  message: string,
): CaptureGrabFailedError {
  return new CaptureGrabFailedError(code, message);
}

function isCaptureGrabFailedError(
  error: unknown,
): error is CaptureGrabFailedError {
  return (
    error instanceof CaptureGrabFailedError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "CaptureGrabFailedError" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string" &&
      "message" in error)
  );
}

/**
 * What the picker's digit/Esc selection resolves to. `escape` covers both
 * the Esc key and any other clean dismissal of the picker.
 */
export type CaptureSelectionEvent =
  | { readonly kind: "clipboard" }
  | { readonly kind: "target"; readonly target: EligibleTarget }
  | { readonly kind: "escape" }
  /** A drag on the preview: trim the capture and keep the picker open. */
  | { readonly kind: "crop"; readonly rect: CropRect };

/**
 * The injected picker handle (concrete implementation lands in the picker UI
 * slice, #31). Owns renderer messaging and shortcut registration; the
 * orchestrator only ever opens it once, appends targets as they resolve,
 * awaits exactly one selection at a time, and closes it on every exit path.
 */
export interface CapturePickerHandle {
  appendTargets(targets: readonly EligibleTarget[]): void;
  awaitSelection(): Promise<CaptureSelectionEvent>;
  close(): void;
}

export type CaptureDeliverOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | { readonly kind: "unknown" };

/** Injectable timer seam so the pane-query and delivery-ack deadlines can be driven by a fake clock. */
export interface CaptureSessionClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * The dependency bag for the shared send session, generic in the artifact type
 * `A` the verb flows through the loop (issue #37). Capture supplies a
 * {@link CaptureArtifact}; a second verb can supply a different payload type
 * with its own grab, preview, crop, clipboard, and delivery — the loop itself
 * is agnostic to what `A` is.
 */
export interface RunSessionDependencies<A> {
  showOverlay(snapshot: OverlaySnapshot): void | Promise<void>;
  /** Rejects with a {@link CaptureGrabFailedError} on a bad grab — never a fake artifact. */
  captureActiveWindow(): Promise<A>;
  openPicker(): CapturePickerHandle;
  /**
   * Best-effort preview of the grab for the picker (#35). An image thumbnail or
   * a relayed-text head — {@link PickerPreview}. Returning null — or rejecting —
   * renders the picker without a preview; it never fails the operation or
   * changes a delivery outcome.
   */
  renderThumbnail?(artifact: A): Promise<PickerPreview | null>;
  /**
   * Trims an artifact to `rect`, returning a fresh artifact (new id, new file)
   * for the cropped pixels. Best-effort: null keeps the uncropped artifact, so
   * a failed crop costs the user nothing but the drag.
   */
  cropCapture?(artifact: A, rect: CropRect): Promise<A | null>;
  queryEligibleTargets(): Promise<HerdrQueryResult>;
  /**
   * Copies the artifact to the local clipboard for digit slot 1 (Capture's
   * pinned Clipboard destination). Optional: Relay skips slot 1 — the clipboard
   * is its *source* — so it registers no `1` and never triggers this.
   */
  copyToClipboard?(artifact: A): void | Promise<void>;
  deliver(artifact: A, target: EligibleTarget): Promise<CaptureDeliverOutcome>;
  /**
   * Overrides the delivering/delivered beats so a verb can show a payload-aware
   * mascot (Relay carries a note/ledger/portrait; issue #41). Defaults to the
   * generic capture-delivering/capture-delivered snapshots — Capture passes
   * neither, so its beats are unchanged. Receives the current (possibly
   * cropped) artifact so the snapshot can reflect what's actually being sent.
   */
  deliveringSnapshot?(artifact: A): OverlaySnapshot;
  deliveredSnapshot?(artifact: A, target: EligibleTarget): OverlaySnapshot;
  /**
   * Whether digit slot 1 is the pinned Clipboard destination (Capture) or
   * skipped (Relay). Only affects the picker snapshot's `clipboardSlot` flag —
   * the actual `1` shortcut is owned by the injected picker handle. Default true.
   */
  clipboardSlot?: boolean;
  /**
   * What slot 1's picker entry reads. Herald relabels it "Paste here" — its
   * slot 1 rides the same digit-1/`clipboard` machinery but pastes the polished
   * transcript into the focused window rather than copying anything (ADR 0003).
   * Absent (Capture) the renderer shows its "Clipboard" default.
   */
  slotOneLabel?: string;
  /**
   * Overrides the beat shown after slot 1's local action, mirroring
   * deliveringSnapshot/deliveredSnapshot. Herald shows dictation's existing
   * `done` ("Pasted, sir.") because its slot 1 IS the Ctrl+Alt+D outcome —
   * no new mascot art. Default: the generic capture-delivered beat.
   */
  clipboardDeliveredSnapshot?(artifact: A): OverlaySnapshot;
  clock?: CaptureSessionClock;
  paneQueryTimeoutMs?: number;
  deliveryAckTimeoutMs?: number;
}

/** The Capture verb's concrete instantiation of the shared session deps. */
export type RunCaptureSessionDependencies =
  RunSessionDependencies<CaptureArtifact>;

export type RunCaptureSessionResult =
  | {
      readonly kind: "capture-failed";
      readonly code: CaptureFailureCode;
      readonly message: string;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "clipboard-delivered" }
  | { readonly kind: "target-delivered"; readonly target: EligibleTarget }
  | {
      readonly kind: "delivery-failed";
      readonly target: EligibleTarget;
      readonly code: string;
      readonly message: string;
    };

const defaultClock: CaptureSessionClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export async function runSendSession<A>(
  dependencies: RunSessionDependencies<A>,
): Promise<RunCaptureSessionResult> {
  const clock = dependencies.clock ?? defaultClock;
  const paneQueryTimeoutMs =
    dependencies.paneQueryTimeoutMs ?? PANE_QUERY_TIMEOUT_MS;
  const deliveryAckTimeoutMs =
    dependencies.deliveryAckTimeoutMs ?? DELIVERY_ACK_TIMEOUT_MS;
  const clipboardSlot = dependencies.clipboardSlot ?? true;

  let artifact: A;
  try {
    artifact = await dependencies.captureActiveWindow();
  } catch (error) {
    if (!isCaptureGrabFailedError(error)) {
      throw error;
    }
    void dependencies.showOverlay(buildErrorOverlaySnapshot(error.message));
    return { kind: "capture-failed", code: error.code, message: error.message };
  }

  // Best-effort throughout: a thumbnail failure must never cost the user
  // their capture, so this swallows everything and falls back to a
  // preview-less picker.
  async function renderPreviewFor(
    forArtifact: A,
  ): Promise<PickerPreview | null> {
    if (!dependencies.renderThumbnail) return null;
    try {
      return await dependencies.renderThumbnail(forArtifact);
    } catch {
      return null;
    }
  }

  async function cropCurrent(rect: CropRect): Promise<A | null> {
    if (!dependencies.cropCapture) return null;
    try {
      return await dependencies.cropCapture(artifact, rect);
    } catch {
      return null;
    }
  }

  const originalArtifact = artifact;
  let preview = await renderPreviewFor(artifact);
  const originalPreview = preview;

  const picker = dependencies.openPicker();
  let pickerClosed = false;
  function closePicker(): void {
    if (pickerClosed) return;
    pickerClosed = true;
    picker.close();
  }

  // The picker re-renders on every crop/reset, so its target list and any
  // local-only message have to outlive the async query that produced them.
  let currentTargets: readonly EligibleTarget[] = [];
  let currentMessage: string | undefined;
  function showPicker(): void {
    void dependencies.showOverlay(
      buildCapturePickerOverlaySnapshot(
        currentTargets,
        currentMessage,
        preview,
        clipboardSlot,
        dependencies.slotOneLabel,
      ),
    );
  }

  showPicker();

  void queryTargetsWithDeadline(
    dependencies.queryEligibleTargets,
    clock,
    paneQueryTimeoutMs,
  ).then((result) => {
    // A query resolving after Esc/dismiss/deadline is ignored — it can
    // never resurrect or mutate a closed picker (instance binding).
    if (pickerClosed) return;

    if (result.kind === "targets") {
      currentTargets = result.targets;
      picker.appendTargets(result.targets);
    } else {
      currentMessage = result.message;
    }
    showPicker();
  });

  for (;;) {
    const selection = await picker.awaitSelection();

    if (selection.kind === "crop") {
      // Crop keeps the picker open and re-renders the preview from the
      // cropped pixels, so the result is seen rather than assumed.
      const cropped = await cropCurrent(selection.rect);
      if (cropped) {
        artifact = cropped;
        preview = await renderPreviewFor(cropped);
      }
      showPicker();
      continue;
    }

    if (selection.kind === "escape") {
      // Esc undoes a crop before it dismisses: a mis-drag that clipped the
      // thing you wanted must cost one keypress, not the whole capture.
      if (artifact !== originalArtifact) {
        artifact = originalArtifact;
        preview = originalPreview;
        showPicker();
        continue;
      }

      closePicker();
      void dependencies.showOverlay(buildCancelledOverlaySnapshot());
      return { kind: "cancelled" };
    }

    if (selection.kind === "clipboard") {
      closePicker();
      await dependencies.copyToClipboard?.(artifact);
      void dependencies.showOverlay(
        dependencies.clipboardDeliveredSnapshot?.(artifact) ??
          buildOverlaySnapshot("capture-delivered"),
      );
      return { kind: "clipboard-delivered" };
    }

    const { target } = selection;
    void dependencies.showOverlay(
      dependencies.deliveringSnapshot?.(artifact) ??
        buildOverlaySnapshot("capture-delivering"),
    );

    const outcome = await deliverWithDeadline(
      () => dependencies.deliver(artifact, target),
      clock,
      deliveryAckTimeoutMs,
    );

    if (outcome.kind === "delivered") {
      closePicker();
      void dependencies.showOverlay(
        dependencies.deliveredSnapshot?.(artifact, target) ??
          buildOverlaySnapshot("capture-delivered"),
      );
      return { kind: "target-delivered", target };
    }

    if (outcome.kind === "failed") {
      closePicker();
      void dependencies.showOverlay(
        buildCaptureDeliveryFailedOverlaySnapshot(outcome.message),
      );
      return {
        kind: "delivery-failed",
        target,
        code: outcome.code,
        message: outcome.message,
      };
    }

    // Unknown: never success, never failure. The picker stays open (Esc
    // during delivering was already a structural no-op — we simply weren't
    // awaiting selection) so the same digit can retry with the same
    // CaptureArtifact id, keeping the retry idempotent.
    void dependencies.showOverlay(buildOverlaySnapshot("capture-delivery-unknown"));
  }
}

/**
 * The Capture verb's entry into the shared session. A thin concrete alias over
 * {@link runSendSession} so existing callers and tests keep their signature;
 * the loop itself is generic in the payload type (issue #37).
 */
export function runCaptureSession(
  dependencies: RunCaptureSessionDependencies,
): Promise<RunCaptureSessionResult> {
  return runSendSession(dependencies);
}

function queryTargetsWithDeadline(
  queryEligibleTargets: () => Promise<HerdrQueryResult>,
  clock: CaptureSessionClock,
  timeoutMs: number,
): Promise<HerdrQueryResult> {
  return new Promise((resolve) => {
    let settled = false;

    const handle = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        kind: "failed",
        code: "pane-query-timeout",
        message: herdrSafeMessageFor("pane-query-timeout"),
      });
    }, timeoutMs);

    queryEligibleTargets().then((result) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(handle);
      resolve(result);
    });
  });
}

function deliverWithDeadline(
  deliver: () => Promise<CaptureDeliverOutcome>,
  clock: CaptureSessionClock,
  timeoutMs: number,
): Promise<CaptureDeliverOutcome> {
  return new Promise((resolve) => {
    let settled = false;

    const handle = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "unknown" });
    }, timeoutMs);

    deliver().then((outcome) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(handle);
      resolve(outcome);
    });
  });
}
