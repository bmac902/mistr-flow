export type RunSessionResult =
  | {
      kind: "polished";
      polishedText: string;
      rawTranscript: string;
    }
  | {
      kind: "raw-fallback";
      rawTranscript: string;
      polishError: Error;
    }
  | {
      kind: "hard-error";
      error: Error;
    };

export interface RunSessionDependencies {
  transcribe(audioBuffer: Buffer): Promise<string>;
  polish(rawTranscript: string): Promise<string>;
  onPolishStart?(): void | Promise<void>;
}

export async function runSession(
  audioBuffer: Buffer,
  dependencies: RunSessionDependencies,
): Promise<RunSessionResult> {
  try {
    const rawTranscript = await dependencies.transcribe(audioBuffer);

    try {
      await dependencies.onPolishStart?.();
      const polishedText = await dependencies.polish(rawTranscript);
      return {
        kind: "polished",
        polishedText,
        rawTranscript,
      };
    } catch (error) {
      return {
        kind: "raw-fallback",
        rawTranscript,
        polishError: toError(error),
      };
    }
  } catch (error) {
    return {
      kind: "hard-error",
      error: toError(error),
    };
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
