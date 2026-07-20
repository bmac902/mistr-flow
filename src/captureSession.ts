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
  type PickerAgainRow,
  type PickerHistoryPosition,
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
  | { readonly kind: "crop"; readonly rect: CropRect }
  /**
   * Left/Right through the capture-history ring (issue #95): step the cursor one
   * entry older/newer, swap the live artifact/preview to it, keep the picker
   * open. A no-op when the session has no history port.
   */
  | { readonly kind: "navigate"; readonly direction: "older" | "newer" }
  /**
   * The verb's own hotkey pressed again while its picker is open (issue #58,
   * ADR 0004): confirm to the Last Target. Carries no target — the session
   * resolves it against its reconciled again-state, so a confirm can never
   * ride a stale remembered snapshot past a reconcile that unmarked it.
   */
  | { readonly kind: "again" };

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
 * Same agent again (issue #58, ADR 0004): the session's window onto the
 * shared Last Target — read once at picker-open so the again-row renders on
 * the FIRST frame, straight from memory, while the pane entries wait out the
 * query. `hotkeyLabel` is the verb's own hotkey, shown on the row: the
 * confirm is keyed to it, never a digit. Absent → no row, and a
 * `kind: "again"` selection is a truthful no-op.
 */
export interface SameAgentAgainDependency {
  readLastTarget(): EligibleTarget | null;
  readonly hotkeyLabel: string;
}

/**
 * The session's window onto the verb's persistent capture-history ring (issue
 * #95). The ring itself lives in main.ts and outlives any one session — the
 * fresh grab is pushed onto it before the picker opens, so `current()` at open
 * equals the just-captured artifact. Optional: a verb without history simply
 * never navigates, and the loop's no-history path is byte-identical to before.
 */
export interface SessionHistoryPort<A> {
  /** Step the cursor one entry older/newer (clamped) and return the entry landed on. */
  navigate(direction: "older" | "newer"): A;
  /**
   * Replace the current entry's artifact in place (a crop), preserving its
   * pre-crop original for Esc's undo. Does not move the cursor or reorder.
   */
  replaceCurrent(artifact: A): void;
  /** The pre-crop original of the current entry — Esc's two-stage undo target. */
  currentOriginal(): A;
  /** Where the cursor sits, for the overlay's position indicator. */
  position(): PickerHistoryPosition;
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
   * Remaps the loop's OWN synthesized pane-query-timeout result — distinct
   * from wrapping `queryEligibleTargets` above, which only ever sees the
   * query promise settle. A verb whose picker states have an invariant on
   * every non-targets message (Herald's "never say Clipboard only", issue
   * #87) needs it applied here too, since the outer deadline below races
   * ahead of that promise and wins whenever the query itself is slow.
   * Absent (Capture, Relay), the shared "Clipboard only" wording is unchanged.
   */
  mapQueryTimeoutResult?(result: HerdrQueryResult): HerdrQueryResult;
  /**
   * Slot 1's local action on the artifact: Capture copies it to the clipboard,
   * Herald pastes it into the focused window. Optional: Relay OMITS it (#64) —
   * its slot 1 keeps the copy that's already on the clipboard, so writing
   * anything would clobber the very content being kept. Omitted, slot 1 still
   * resolves and shows its beat; it just performs no local write.
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
   * Whether digit slot 1 renders the pinned local outcome. True for every verb
   * since #64 (CONTEXT.md, "Slot 1 is the local outcome in every verb"). Only
   * affects the picker snapshot's `clipboardSlot` flag — the actual `1`
   * shortcut is owned by the injected picker handle. Default true.
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
   * `done` ("Pasted, sir.") because its slot 1 IS the Ctrl+Alt+D outcome;
   * Relay rides the same phase with copy naming the kept clipboard (#64) —
   * no new mascot art. Default: the generic capture-delivered beat.
   */
  clipboardDeliveredSnapshot?(artifact: A): OverlaySnapshot;
  /**
   * Same agent again (issue #58, ADR 0004): the shared Last Target memory
   * plus the verb hotkey the again-row is keyed to. Optional — a verb
   * without it simply has no fast path.
   */
  again?: SameAgentAgainDependency;
  /**
   * The verb's persistent capture-history ring (issue #95). Present → Left/Right
   * arrow through the last-N grabs, crops route through in-place replacement, and
   * the picker carries a position indicator. Absent → the one-shot behaviour this
   * module has always had, unchanged.
   */
  history?: SessionHistoryPort<A>;
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

  // Same agent again (issue #58, ADR 0004): the Last Target is read once at
  // open, so the again-row rides the picker's FIRST frame straight from
  // memory — pane entries wait out the up-to-2s query; the fast path must
  // not. `againTarget` is what a verb-key confirm resolves to RIGHT NOW: the
  // remembered pane until the query lands (validate-at-use — a confirm that
  // races the reconcile onto a since-dead pane fails truthfully through the
  // ordinary delivery failure), the fresh entry once confirmed present, and
  // null once the reconcile unmarks the row.
  const remembered = dependencies.again?.readLastTarget() ?? null;
  let againTarget: EligibleTarget | null = remembered;
  let againRow: PickerAgainRow | undefined =
    remembered && dependencies.again
      ? {
          label: remembered.label,
          hotkeyLabel: dependencies.again.hotkeyLabel,
          state: "live",
        }
      : undefined;

  const history = dependencies.history;

  // The picker re-renders on every crop/reset/navigation, so its target list
  // and any local-only message have to outlive the async query that produced
  // them.
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
        againRow,
        history?.position(),
      ),
    );
  }

  showPicker();

  void queryTargetsWithDeadline(
    dependencies.queryEligibleTargets,
    clock,
    paneQueryTimeoutMs,
    dependencies.mapQueryTimeoutResult,
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

    // Reconcile the again-row against the fresh query (ADR 0004): still
    // present → the label/status refreshes and the confirm re-binds to the
    // fresh entry; gone — or unconfirmable, a failed query returns no list —
    // → the row visibly unmarks, never silently, and the fast path degrades
    // to the normal picker.
    if (remembered && againRow) {
      const fresh =
        result.kind === "targets"
          ? result.targets.find((t) => t.target === remembered.target)
          : undefined;
      if (fresh) {
        againTarget = fresh;
        againRow = { ...againRow, label: fresh.label };
      } else {
        againTarget = null;
        againRow = { ...againRow, state: "unmarked" };
      }
    }

    showPicker();
  });

  for (;;) {
    const selection = await picker.awaitSelection();

    if (selection.kind === "navigate") {
      // Arrow through the history ring: move the cursor, swap the live artifact
      // and preview to the entry landed on, re-render. A no-op without history
      // (the arrows are never registered for such a picker, but stay defensive).
      if (history) {
        artifact = history.navigate(selection.direction);
        preview = await renderPreviewFor(artifact);
        showPicker();
      }
      continue;
    }

    if (selection.kind === "crop") {
      // Crop keeps the picker open and re-renders the preview from the
      // cropped pixels, so the result is seen rather than assumed.
      const cropped = await cropCurrent(selection.rect);
      if (cropped) {
        artifact = cropped;
        // Route the crop through in-place replacement so it survives arrowing
        // away and back (issue #94's contract), and its pre-crop original stays
        // available for Esc's undo below.
        history?.replaceCurrent(cropped);
        preview = await renderPreviewFor(cropped);
      }
      showPicker();
      continue;
    }

    if (selection.kind === "escape") {
      // Esc undoes a crop before it dismisses: a mis-drag that clipped the
      // thing you wanted must cost one keypress, not the whole capture. With
      // history the undo target is the CURRENT entry's pre-crop original (you
      // may have arrowed onto it); without, the session-start artifact.
      if (history) {
        const original = history.currentOriginal();
        if (artifact !== original) {
          artifact = original;
          history.replaceCurrent(original);
          preview = await renderPreviewFor(original);
          showPicker();
          continue;
        }
      } else if (artifact !== originalArtifact) {
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

    // The verb-key confirm (issue #58): with a live row it resolves to the
    // reconciled Last Target and flows into the ordinary delivery path below
    // — same ledger, same unknown → retry, same bracketing as a digit press.
    // Without one (no memory, or the reconcile unmarked it) it is a truthful
    // no-op: nothing was refused, there is nothing to repeat, and the row's
    // absence/unmark on screen is the explanation (jump-hotkey precedent —
    // a no-op whose reason is visible is not a silent no-op).
    let target: EligibleTarget;
    if (selection.kind === "again") {
      if (againTarget === null) continue;
      target = againTarget;
    } else {
      target = selection.target;
    }

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
  mapTimeoutResult?: (result: HerdrQueryResult) => HerdrQueryResult,
): Promise<HerdrQueryResult> {
  return new Promise((resolve) => {
    let settled = false;

    const handle = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutResult: HerdrQueryResult = {
        kind: "failed",
        code: "pane-query-timeout",
        message: herdrSafeMessageFor("pane-query-timeout"),
      };
      resolve(mapTimeoutResult?.(timeoutResult) ?? timeoutResult);
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
