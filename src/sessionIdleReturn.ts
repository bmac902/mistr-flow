export interface SessionIdleReturn {
  schedule(): void;
  afterCleanup(): void;
}

export interface SessionIdleReturnDependencies {
  delayMs?: number;
  isActive(): boolean;
  hasActiveSession(): boolean;
  sendIdle(): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
}

export function createSessionIdleReturn({
  delayMs = 5000,
  isActive,
  hasActiveSession,
  sendIdle,
  setTimeout,
}: SessionIdleReturnDependencies): SessionIdleReturn {
  let idleDueAfterCleanup = false;

  return {
    schedule() {
      setTimeout(() => {
        if (isActive()) {
          idleDueAfterCleanup = true;
          return;
        }

        if (!hasActiveSession()) sendIdle();
      }, delayMs);
    },

    afterCleanup() {
      if (hasActiveSession() || !idleDueAfterCleanup) return;

      idleDueAfterCleanup = false;
      sendIdle();
    },
  };
}
