export type OverlayPhase =
  | "idle"
  | "listening"
  | "recording"
  | "processing"
  | "polishing"
  | "done"
  | "error";

export interface OverlaySnapshot {
  phase: OverlayPhase;
  barMode: "peek" | "expanded";
  waveformVisible: boolean;
  mascotCopy: string;
  toastCopy?: string;
}

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
        mascotCopy: "hat + eyes",
      };
    case "listening":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: true,
        mascotCopy: "listening",
      };
    case "recording":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: true,
        mascotCopy: "recording",
      };
    case "processing":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: "processing",
      };
    case "polishing":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: "polishing",
      };
    case "done":
      return {
        phase,
        barMode: "expanded",
        waveformVisible: false,
        mascotCopy: "done",
      };
    case "error":
      return buildErrorOverlaySnapshot();
  }
}

export function buildErrorOverlaySnapshot(
  toastCopy?: string,
): OverlaySnapshot {
  return {
    phase: "error",
    barMode: "expanded",
    waveformVisible: false,
    mascotCopy: "error",
    toastCopy,
  };
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
