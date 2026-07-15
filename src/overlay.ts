export type OverlayPhase =
  | "idle"
  | "listening"
  | "recording"
  | "cancelled"
  | "processing"
  | "polishing"
  | "done"
  | "error"
  | "refused";

export interface OverlaySnapshot {
  phase: OverlayPhase;
  barMode: "peek" | "expanded";
  waveformVisible: boolean;
  mascotCopy: string;
  statusCopy: string;
  toastCopy?: string;
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
};

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
  }
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
