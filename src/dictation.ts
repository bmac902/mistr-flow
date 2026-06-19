import {
  buildErrorOverlaySnapshot,
  buildOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";
import { runSession, type RunSessionResult } from "./session";

export interface RunDictationSessionDependencies {
  showOverlay(snapshot: OverlaySnapshot): void | Promise<void>;
  playBeep(): void | Promise<void>;
  recordAudio(): Promise<Buffer>;
  transcribe(audioBuffer: Buffer): Promise<string>;
  polish(rawTranscript: string): Promise<string>;
  pasteText(text: string): Promise<void> | void;
}

export async function runDictationSession(
  dependencies: RunDictationSessionDependencies,
): Promise<RunSessionResult> {
  void dependencies.showOverlay(buildOverlaySnapshot("listening"));
  void dependencies.playBeep();
  void dependencies.showOverlay(buildOverlaySnapshot("recording"));

  const audioBuffer = await dependencies.recordAudio();
  void dependencies.showOverlay(buildOverlaySnapshot("processing"));

  const result = await runSession(audioBuffer, {
    transcribe: dependencies.transcribe,
    polish: dependencies.polish,
    onPolishStart() {
      void dependencies.showOverlay(buildOverlaySnapshot("polishing"));
    },
  });

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
