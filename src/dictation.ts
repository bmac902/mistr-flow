import {
  buildCancelledOverlaySnapshot,
  buildErrorOverlaySnapshot,
  buildOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";
import { runSession, type RunSessionResult } from "./session";

export type DictationCancelReason = "dead-zone" | "escape";

export class DictationCancelledError extends Error {
  readonly reason: DictationCancelReason;

  constructor(reason: DictationCancelReason) {
    super(`Dictation cancelled: ${reason}`);
    this.name = "DictationCancelledError";
    this.reason = reason;
  }
}

export function createDictationCancelledError(
  reason: DictationCancelReason,
): DictationCancelledError {
  return new DictationCancelledError(reason);
}

/**
 * Voice's front half — the beats and calls shared by plain Dictation and
 * Herald (issue #55, ADR 0003): listening/recording/cancel handling, the
 * dead-zone debounce, then transcribe → Polish with their beats. What happens
 * to the resulting text is the verb's back half: Dictation pastes it locally;
 * Herald routes it through the send session to a pane.
 */
export interface RunDictationFrontHalfDependencies {
  showOverlay(snapshot: OverlaySnapshot): void | Promise<void>;
  playBeep(): void | Promise<void>;
  recordAudio(): Promise<Buffer>;
  transcribe(audioBuffer: Buffer): Promise<string>;
  polish(rawTranscript: string): Promise<string>;
}

export interface RunDictationSessionDependencies
  extends RunDictationFrontHalfDependencies {
  pasteText(text: string): Promise<void> | void;
}

export type RunDictationSessionResult =
  | RunSessionResult
  | {
      kind: "cancelled";
      reason: DictationCancelReason;
    };

export async function runDictationFrontHalf(
  dependencies: RunDictationFrontHalfDependencies,
): Promise<RunDictationSessionResult> {
  void dependencies.showOverlay(buildOverlaySnapshot("listening"));
  void dependencies.playBeep();
  void dependencies.showOverlay(buildOverlaySnapshot("recording"));

  let audioBuffer: Buffer;
  try {
    audioBuffer = await dependencies.recordAudio();
  } catch (error) {
    if (isDictationCancelledError(error)) {
      void dependencies.showOverlay(buildCancelledOverlaySnapshot());
      return {
        kind: "cancelled",
        reason: error.reason,
      };
    }

    throw error;
  }

  if (audioBuffer.length < 100) {
    void dependencies.showOverlay(buildCancelledOverlaySnapshot());
    return { kind: "cancelled", reason: "dead-zone" };
  }

  void dependencies.showOverlay(buildOverlaySnapshot("processing"));

  return runSession(audioBuffer, {
    transcribe: dependencies.transcribe,
    polish: dependencies.polish,
    onPolishStart() {
      void dependencies.showOverlay(buildOverlaySnapshot("polishing"));
    },
  });
}

export async function runDictationSession(
  dependencies: RunDictationSessionDependencies,
): Promise<RunDictationSessionResult> {
  const result = await runDictationFrontHalf(dependencies);

  if (result.kind === "polished") {
    await dependencies.pasteText(result.polishedText);
    void dependencies.showOverlay(buildOverlaySnapshot("done"));
    return result;
  }

  if (result.kind === "raw-fallback") {
    void dependencies.showOverlay(buildErrorOverlaySnapshot());
    await dependencies.pasteText(result.rawTranscript);
  }

  if (result.kind === "hard-error") {
    void dependencies.showOverlay(
      buildErrorOverlaySnapshot(result.error.message),
    );
  }

  return result;
}

function isDictationCancelledError(
  error: unknown,
): error is DictationCancelledError {
  return (
    error instanceof DictationCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "DictationCancelledError" &&
      "reason" in error &&
      ((error as { reason?: unknown }).reason === "dead-zone" ||
        (error as { reason?: unknown }).reason === "escape"))
  );
}
