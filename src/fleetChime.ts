import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { callHerdrSocket, type HerdrSocketDeps } from "./herdrSocket";

// The two active cues of fleet awareness (ADR 0007, amending ADR 0006 §§2–3):
// one chime the moment a watched agent finishes, one the moment a block is real,
// each fired only when you aren't already looking at Herdr. Both ride the same
// pure gate and the same foreground seam — the cues differ only in their sound.
//
// The sounds are distinguished by *rhythm*, not pitch: done is a single soft
// tone, blocked is a double beep. Pitch alone proved hard to discriminate from
// another window, which is exactly the situation both cues exist for.
//
// All the decision logic is pure and lives in shouldChime; the foreground seam
// and the sound are the only effects, both injectable so the whole thing is
// driven from fake inputs in tests.

/** One execFile shape, matching herdrWindow's — callback is (error, stdout, stderr). */
export type ChimeExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  callback: (
    error: (Error & { code?: string | number }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => void;

const defaultExecFile: ChimeExecFile = (file, args, callback) => {
  nodeExecFile(file, [...args], (error, stdout, stderr) => {
    callback(error as (Error & { code?: string | number }) | null, stdout ?? "", stderr ?? "");
  });
};

/** One tone in a chime: a frequency and a duration, straight to `[console]::beep`. */
export interface ChimeTone {
  readonly hz: number;
  readonly ms: number;
}

/**
 * A chime is a sequence of tones separated by a fixed gap. The gap is not
 * cosmetic: `[console]::beep` is synchronous, so back-to-back calls with no
 * sleep between them render as ONE continuous tone — the rhythm that makes the
 * two cues tellable apart only exists because of the silence.
 */
export interface ChimePattern {
  readonly tones: readonly ChimeTone[];
  readonly gapMs: number;
}

/**
 * Done: one soft, low tone — "your work is ready." Deliberately gentler than
 * blocked, because a completion is not a bottleneck. Exact feel is tuned in
 * human verification; the invariants asserted here are that it is lower and
 * shorter than blocked, and that it is a *single* tone.
 */
export const DONE_CHIME: ChimePattern = {
  tones: [{ hz: 587, ms: 90 }],
  gapMs: 60,
};

/**
 * Blocked: two quick higher beeps — "something needs you." The doubling, not
 * the pitch, is what carries the meaning; 60 ms of silence is enough to read as
 * two events rather than one long note (ADR 0007).
 */
export const BLOCKED_CHIME: ChimePattern = {
  tones: [
    { hz: 900, ms: 70 },
    { hz: 900, ms: 70 },
  ],
  gapMs: 60,
};

/**
 * Render a pattern as one PowerShell command. Tones are joined by an explicit
 * sleep so the gap actually exists; a single-tone pattern emits no sleep at all.
 */
export function chimeCommand(pattern: ChimePattern): string {
  return pattern.tones
    .map((tone) => `[console]::beep(${tone.hz},${tone.ms})`)
    .join(`;Start-Sleep -Milliseconds ${pattern.gapMs};`);
}

/**
 * Sound one chime. Best-effort like every other cue — a failed beep never
 * interrupts anything. The execFile seam lets tests assert the parameters at the
 * call site rather than by ear, which is the only way this is verifiable in an
 * environment with no audio.
 */
export function playChime(
  pattern: ChimePattern,
  execFile: ChimeExecFile = defaultExecFile,
): void {
  execFile(
    "powershell",
    ["-NoProfile", "-WindowStyle", "Hidden", "-Command", chimeCommand(pattern)],
    () => {
      // Best-effort cue only — a failure here must not disturb the fleet loop.
    },
  );
}

/** Sound the done chime once. */
export function playDoneChime(execFile: ChimeExecFile = defaultExecFile): void {
  playChime(DONE_CHIME, execFile);
}

/** Sound the blocked chime once. */
export function playBlockedChime(execFile: ChimeExecFile = defaultExecFile): void {
  playChime(BLOCKED_CHIME, execFile);
}

export interface ChimeDecision {
  /**
   * fleetState's one-shot for this cue: the targets that just crossed into the
   * announced state on this observe (`newlyDoneTargets` or `newlyBlockedTargets`).
   */
  readonly newlyTargets: readonly string[];
  /** This cue's own config flag (`doneChime` / `blockedChime`, both default on). */
  readonly chimeEnabled: boolean;
  /** Whether a verb (dictation/relay) is active — every chime yields to it. */
  readonly verbActive: boolean;
  /** Whether Herdr's host window is the OS foreground window *right now*. */
  readonly herdrForeground: boolean;
}

/**
 * The pure gate, shared by both cues (ADR 0006 §3, extended to blocked by ADR
 * 0007): a chime is due exactly when its one-shot just fired, the cue is
 * enabled, no verb is active, and Herdr is not the foreground window at this
 * transition. Because each one-shot fires only on the transition poll,
 * evaluating this per poll gives *consume-on-suppress* for free: Herdr-foreground
 * at the transition swallows the chime (the one-shot is spent), so it is never
 * deferred to a later alt-tab.
 */
export function shouldChime(input: ChimeDecision): boolean {
  if (input.newlyTargets.length === 0) return false;
  if (!input.chimeEnabled) return false;
  if (input.verbActive) return false;
  if (input.herdrForeground) return false;
  return true;
}

/** "Is Herdr's host window the OS foreground window right now?" — the injected seam. */
export type IsHerdrForeground = () => Promise<boolean>;

const DEFAULT_FIND_SCRIPT = path.join(__dirname, "..", "scripts", "find-window-by-title.ps1");
const DEFAULT_FOREGROUND_SCRIPT = path.join(
  __dirname,
  "..",
  "scripts",
  "is-window-foreground.ps1",
);

/** Helper exit codes are the scripts' contract — see scripts/is-window-foreground.ps1. */
const EXIT_WINDOW_GONE = 3;

export interface HerdrForegroundDeps {
  readonly execFile?: ChimeExecFile;
  /**
   * Herdr's socket path for a static injection (tests). In production prefer
   * {@link readSocketPath}, which re-reads it per identify so a Herdr that starts
   * after Mistr Flow is still found.
   */
  readonly socketPath?: string | null;
  /** Resolve Herdr's socket path fresh at identify time (mirrors focusPane). */
  readonly readSocketPath?: () => Promise<string | null>;
  readonly findScriptPath?: string;
  readonly foregroundScriptPath?: string;
  readonly mintNonce?: () => string;
  readonly socketDeps?: HerdrSocketDeps;
}

/**
 * Production foreground seam, reusing ADR 0002's minted-title host-window
 * identification: find the HWND once (mint a title, set it via the socket, locate
 * the window wearing it, restore the title), cache it, then compare cheaply per
 * poll. When the cached handle has gone stale (the window closed and its HWND was
 * reused or vanished) the compare reports it and we re-identify once.
 *
 * Can't-see-Herdr defaults to *not foreground*: if the window can't be found at
 * all you are plainly not looking at Herdr, so the cue should still fire — the
 * feature exists precisely to reach you while you're heads-down elsewhere.
 */
export function createHerdrForegroundCheck(
  deps: HerdrForegroundDeps = {},
): IsHerdrForeground {
  const execFile = deps.execFile ?? defaultExecFile;
  const findScriptPath = deps.findScriptPath ?? DEFAULT_FIND_SCRIPT;
  const foregroundScriptPath = deps.foregroundScriptPath ?? DEFAULT_FOREGROUND_SCRIPT;
  const mintNonce = deps.mintNonce ?? (() => randomUUID().slice(0, 8));

  // The cached host-window handle. Null means "not yet identified / gone stale".
  let cachedHwnd: string | null = null;

  async function identify(): Promise<string | null> {
    const socketPath = deps.readSocketPath ? await deps.readSocketPath() : deps.socketPath;
    if (!socketPath) return null;

    const title = `herdr - mistr flow ${mintNonce()}`;
    const setOutcome = await callHerdrSocket(
      socketPath,
      "client.window_title.set",
      { title },
      deps.socketDeps,
    );
    if (setOutcome.kind !== "ok" || setOutcome.result.changed !== true) {
      if (setOutcome.kind === "ok") await clearTitle(socketPath);
      return null;
    }

    try {
      return await runFind(title);
    } finally {
      await clearTitle(socketPath);
    }
  }

  function clearTitle(socketPath: string): Promise<unknown> {
    return callHerdrSocket(socketPath, "client.window_title.clear", {}, deps.socketDeps);
  }

  function runFind(title: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", findScriptPath, "-Title", title],
        (error, stdout) => {
          if (error) {
            resolve(null); // no window wears the title (exit 3) or the helper failed
            return;
          }
          const hwnd = stdout.trim();
          resolve(hwnd ? hwnd : null);
        },
      );
    });
  }

  type CompareResult = "foreground" | "not-foreground" | "stale";

  function compareForeground(hwnd: string): Promise<CompareResult> {
    return new Promise((resolve) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          foregroundScriptPath,
          "-Hwnd",
          hwnd,
        ],
        (error) => {
          if (!error) {
            resolve("foreground");
            return;
          }
          resolve(error.code === EXIT_WINDOW_GONE ? "stale" : "not-foreground");
        },
      );
    });
  }

  return async () => {
    if (cachedHwnd === null) {
      cachedHwnd = await identify();
      if (cachedHwnd === null) return false;
    }

    const result = await compareForeground(cachedHwnd);
    if (result !== "stale") return result === "foreground";

    // The cached window vanished — re-identify once and compare against the fresh
    // handle. A second staleness (Herdr genuinely gone) resolves to not-foreground.
    cachedHwnd = await identify();
    if (cachedHwnd === null) return false;
    const retry = await compareForeground(cachedHwnd);
    return retry === "foreground";
  };
}
