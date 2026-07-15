import type { CaptureArtifact, CaptureFailureCode } from "./capture";
import type { CapturePreview } from "./captureThumbnail";
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
  | { readonly kind: "escape" };

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

export interface RunCaptureSessionDependencies {
  showOverlay(snapshot: OverlaySnapshot): void | Promise<void>;
  /** Rejects with a {@link CaptureGrabFailedError} on a bad grab — never a fake artifact. */
  captureActiveWindow(): Promise<CaptureArtifact>;
  openPicker(): CapturePickerHandle;
  /**
   * Best-effort preview of the grab for the picker (#35). Returning null — or
   * rejecting — renders the picker without a preview; it never fails the
   * capture or changes a delivery outcome.
   */
  renderThumbnail?(artifact: CaptureArtifact): Promise<CapturePreview | null>;
  queryEligibleTargets(): Promise<HerdrQueryResult>;
  copyToClipboard(artifact: CaptureArtifact): void | Promise<void>;
  deliver(
    capture: CaptureArtifact,
    target: EligibleTarget,
  ): Promise<CaptureDeliverOutcome>;
  clock?: CaptureSessionClock;
  paneQueryTimeoutMs?: number;
  deliveryAckTimeoutMs?: number;
}

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

export async function runCaptureSession(
  dependencies: RunCaptureSessionDependencies,
): Promise<RunCaptureSessionResult> {
  const clock = dependencies.clock ?? defaultClock;
  const paneQueryTimeoutMs =
    dependencies.paneQueryTimeoutMs ?? PANE_QUERY_TIMEOUT_MS;
  const deliveryAckTimeoutMs =
    dependencies.deliveryAckTimeoutMs ?? DELIVERY_ACK_TIMEOUT_MS;

  let artifact: CaptureArtifact;
  try {
    artifact = await dependencies.captureActiveWindow();
  } catch (error) {
    if (!isCaptureGrabFailedError(error)) {
      throw error;
    }
    void dependencies.showOverlay(buildErrorOverlaySnapshot(error.message));
    return { kind: "capture-failed", code: error.code, message: error.message };
  }

  // Best-effort: a thumbnail failure must never cost the user their capture,
  // so this swallows everything and falls back to a preview-less picker.
  let preview: CapturePreview | null = null;
  if (dependencies.renderThumbnail) {
    try {
      preview = await dependencies.renderThumbnail(artifact);
    } catch {
      preview = null;
    }
  }

  const picker = dependencies.openPicker();
  let pickerClosed = false;
  function closePicker(): void {
    if (pickerClosed) return;
    pickerClosed = true;
    picker.close();
  }

  void dependencies.showOverlay(buildCapturePickerOverlaySnapshot([], undefined, preview));

  void queryTargetsWithDeadline(
    dependencies.queryEligibleTargets,
    clock,
    paneQueryTimeoutMs,
  ).then((result) => {
    // A query resolving after Esc/dismiss/deadline is ignored — it can
    // never resurrect or mutate a closed picker (instance binding).
    if (pickerClosed) return;

    if (result.kind === "targets") {
      picker.appendTargets(result.targets);
      void dependencies.showOverlay(
        buildCapturePickerOverlaySnapshot(result.targets, undefined, preview),
      );
    } else {
      void dependencies.showOverlay(
        buildCapturePickerOverlaySnapshot([], result.message, preview),
      );
    }
  });

  for (;;) {
    const selection = await picker.awaitSelection();

    if (selection.kind === "escape") {
      closePicker();
      void dependencies.showOverlay(buildCancelledOverlaySnapshot());
      return { kind: "cancelled" };
    }

    if (selection.kind === "clipboard") {
      closePicker();
      await dependencies.copyToClipboard(artifact);
      void dependencies.showOverlay(buildOverlaySnapshot("capture-delivered"));
      return { kind: "clipboard-delivered" };
    }

    const { target } = selection;
    void dependencies.showOverlay(buildOverlaySnapshot("capture-delivering"));

    const outcome = await deliverWithDeadline(
      () => dependencies.deliver(artifact, target),
      clock,
      deliveryAckTimeoutMs,
    );

    if (outcome.kind === "delivered") {
      closePicker();
      void dependencies.showOverlay(buildOverlaySnapshot("capture-delivered"));
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
