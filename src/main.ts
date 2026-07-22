import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session as electronSession,
  dialog,
  type NativeImage,
} from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildBarContextMenu,
  openConfigFileWithDefaultHandler,
  runBarContextMenuAction,
} from "./barControls";
import {
  getConfigPath,
  readCopySelectionFirst,
  readDoneChime,
  readAppTargets,
  readFocusOnDeliver,
  readBlockedChime,
  readMuteSystemAudioWhileRecording,
  readOverlayPosition,
  readProjectAnchors,
  readProvider,
  readVocabularyConfig,
  writeOverlayPosition,
} from "./config";
import { resolveProjectAnchor, type ProjectAnchor } from "./projectAnchors";
import { resolveAiProvider, type AiProvider } from "./aiProvider";
import { createDictationCancelledError, runDictationSession } from "./dictation";
import { buildPolishVocabularyInstruction, buildWhisperVocabularyPrompt } from "./vocabulary";
import { pasteText as pasteTextImpl } from "./paste";
import {
  type AnchoredTarget,
  buildCaptureDeliveryFailedOverlaySnapshot,
  buildFleetPostureOverlaySnapshot,
  buildOverlaySnapshot,
  buildPasteNothingCapturedOverlaySnapshot,
  buildRefusedOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";
import { createFleetState, type FleetPosture } from "./fleetState";
import { attentionCycle, createBlockedJumpCursor } from "./blockedJumpCursor";
import {
  createHerdrForegroundCheck,
  playBlockedChime,
  playDoneChime,
  shouldChime,
  type IsHerdrForeground,
} from "./fleetChime";
import { focusHerdrPane } from "./focusPane";
import { createActiveVerbLock } from "./activeVerbLock";
import {
  clampOverlayPosition,
  resolveOverlayPosition,
  type OverlayPosition,
} from "./overlayPosition";
import { createSessionIdleReturn, type SessionIdleReturn } from "./sessionIdleReturn";
import { muteSystemAudio, type SystemAudioMuteHandle } from "./systemAudio";
import {
  captureActiveWindow as captureActiveWindowImpl,
  defaultCaptureDir,
  sweepExpiredCaptures,
  type CaptureArtifact,
} from "./capture";
import {
  parseFileDropListOutput,
  readClipboardSource,
  type ClipboardSourcePort,
} from "./clipboardSource";
import {
  runRelaySession,
  relayArtifactPaths,
  type RelayArtifact,
} from "./relaySession";
import { runHeraldSession } from "./heraldSession";
import {
  createCaptureGrabFailedError,
  runCaptureSession,
  type CaptureDeliverOutcome,
  type CapturePickerHandle,
  type SessionHistoryPort,
} from "./captureSession";
import {
  createCapturePickerHandle,
  type AgainSource,
  type CancelSource,
  type CropSource,
  type HistorySource,
  type PasteSource,
  type PickerRowClick,
  type RowClickSource,
} from "./capturePickerHandle";
import {
  createCaptureHistory,
  isRetainedByAny,
  type CaptureHistory,
} from "./captureHistory";
import { decideVerbStart, type Verb } from "./verbArbiter";
import { routeBarClick } from "./barClickRouting";
import {
  cropCaptureImage,
  type CropImagePort,
  type CropRect,
} from "./captureCrop";
import {
  renderCapturePreview,
  type CapturePreview,
  type ThumbnailImagePort,
} from "./captureThumbnail";
import {
  captureArtifactToPayload,
  createHerdrDeliveryAdapter,
  type SendPayload,
} from "./deliver";
import { runForegroundPaste } from "./foregroundPaste";
import {
  appTargetToEligibleTarget,
  type AppTarget,
} from "./appTargets";
import {
  createAppDeliveryAdapter,
  createRoutingDeliveryAdapter,
  type AppDeliveryDeps,
} from "./appDeliver";
import { composePickerTargets } from "./pickerTargets";
import { createLastTargetMemory, withLastTargetRecording } from "./lastTarget";
import {
  queryHerdr,
  queryWatchedSet,
  readHerdrSocketPath,
  type EligibleTarget,
} from "./herdr";
import {
  capturePickerWindowHeight,
  resolveGrownWindowBounds,
  type WindowBounds,
} from "./captureWindowBounds";
import { nativeWindowHandleToHwnd } from "./nativeWindowHandle";

let overlayWindow: BrowserWindow | null = null;
let aiProvider: AiProvider | null = null;
let muteSystemAudioWhileRecording = true;

// Project Anchors (2026-07-17): per-machine cwd → {name, glyph} mapping for
// the picker rows' WHERE channel. Read once at startup; empty means rows fall
// back to raw labels. Deliberately config, never source — two machines, two
// project sets, and MF learns no project semantics.
let projectAnchors: ProjectAnchor[] = [];
// App Targets (ChatGPT-as-target, 2026-07-17): per-machine config-driven relay
// destinations that are NOT Herdr panes — focus the app's window and paste.
// Read once at startup; empty means the picker offers no app targets. Same
// "config, never source; MF learns no app semantics" posture as projectAnchors.
let appTargets: AppTarget[] = [];
let copySelectionFirst = false;
// ADR 0007: the blocked chime is on by default; config can silence the sound
// while keeping the visual fleet awareness. Read once at startup.
let blockedChime = true;
// PRD #77 / #80: the one soft done chime is on by default; config can silence the
// sound while keeping the done badge and jump gesture. Read once at startup.
let doneChime = true;
let whisperVocabularyPrompt: string | null = null;
let polishVocabularyInstruction: string | null = null;

interface ActiveSession {
  /**
   * Which verb owns the microphone: plain Dictation, or Herald (issue #55),
   * whose recording is the front half of a routed send. Each hotkey
   * toggle-stops only its OWN recording — any other press lands on the verb
   * lock and refuses, so active dictation is never interrupted by Herald or
   * vice versa.
   */
  verb: "dictation" | "herald";
  resolveAudio(buffer: Buffer): void;
  rejectAudio(error: Error): void;
  systemAudioMutePromise: Promise<SystemAudioMuteHandle | null>;
  cleanupPromise: Promise<void> | null;
  idleReturn: SessionIdleReturn;
}

let activeSession: ActiveSession | null = null;
let quitAfterSessionCleanup = false;

// Authoritative synchronous check-and-set lock, consulted at the top of
// every global-hotkey entry point. A pure policy check alone can't prevent
// near-simultaneous globalShortcut callbacks from starting two verbs at once.
const verbLock = createActiveVerbLock();

// Bounds the overlay window is grown back down to on dismiss, failure, or
// completion of a capture session (issue #31, PRD #24) — captured fresh at
// the start of each session, since the overlay can be dragged between runs.
let captureRestingBounds: WindowBounds | null = null;

const CAPTURE_WINDOW_RESTORE_PHASES: ReadonlySet<OverlaySnapshot["phase"]> = new Set([
  "error",
  "cancelled",
  "capture-delivered",
  "capture-delivery-failed",
  // Herald's slot-1 salvage ends on dictation's done beat ("Pasted, sir."),
  // and Relay's slot-1 copy-kept beat (#64) rides the same phase with its own
  // status copy — so the picker-grown window must shrink back on it. Plain
  // dictation never routes through showCaptureOverlay, so this entry can't
  // affect it.
  "done",
]);

// The last overlay state that wasn't the refusal — so when refused self-clears
// we can restore whatever the active verb was actually showing, rather than
// blanking to idle over a live session.
let lastNonRefusedOverlay: OverlaySnapshot | null = null;

function sendToRenderer(channel: string, payload?: unknown): void {
  if (
    channel === "overlay-state" &&
    payload &&
    typeof payload === "object" &&
    (payload as OverlaySnapshot).phase !== "refused"
  ) {
    lastNonRefusedOverlay = payload as OverlaySnapshot;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
}

/** How long the "One thing at a time, sir." refusal holds before self-clearing. */
const REFUSED_HOLD_MS = 3500;
let refusedReturnTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRefusedReturn(): void {
  if (refusedReturnTimer) {
    clearTimeout(refusedReturnTimer);
    refusedReturnTimer = null;
  }
}

/**
 * Shows the mutual-exclusion refusal, then clears it on its own after a few
 * seconds so it never sits there until Esc. On clear it RESTORES whatever the
 * active verb was showing (e.g. the Relay picker you refused capture over is
 * still open underneath), or idle if nothing is active — so a refusal is a
 * transient notice, never a trap.
 */
function refuseVerb(): void {
  const restore = lastNonRefusedOverlay;
  sendToRenderer("overlay-state", buildRefusedOverlaySnapshot());
  cancelRefusedReturn();
  refusedReturnTimer = setTimeout(() => {
    refusedReturnTimer = null;
    if (verbLock.activeVerb() !== null && restore) {
      sendToRenderer("overlay-state", restore);
    } else {
      sendToRenderer("overlay-state", buildOverlaySnapshot("idle"));
    }
  }, REFUSED_HOLD_MS);
}

// Fleet awareness (PRD #44, issue #49): poll the whole Watched Set on a cheap
// timer and let the pure fleetState tracker fold each snapshot into an ambient
// posture. Cadence ~3.5s — spike-confirmed safe, and a real block holds far
// longer, so polling loses nothing versus the socket stream (which stays out of
// scope per ADR 0002). Polling runs continuously, even mid-verb, so the instant
// the bar returns to idle the posture is already current.
const FLEET_POLL_INTERVAL_MS = 3500;
const fleetState = createFleetState();
let fleetPollTimer: ReturnType<typeof setInterval> | null = null;

// Reclaim expired capture/relay temp files. A 5-minute cadence against the
// 15-minute TTL means a file lives at most ~20 minutes past its last touch
// while giving three sweep opportunities inside every TTL window, so nothing
// mid-flight is caught and nothing lingers for long. Left unrun, this dir grew
// to hundreds of MB of retained screenshots over a work week (issue #93).
const CAPTURE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let captureSweepTimer: ReturnType<typeof setInterval> | null = null;

// The Capture verb's persistent history ring (issue #94/#95): the last ~10
// screenshots, arrow-navigable in the picker. It outlives any one session, so
// it lives at module scope. Count-bounded only — capture PNGs live on disk (the
// TTL sweep owns that reclaim), not in memory, so a huge byte budget keeps the
// ring purely a recency window. Relay's own ring (issue #96) is byte-bounded
// because its clipboard images are held in memory.
const captureHistory = createCaptureHistory<CaptureArtifact>({
  maxBytes: Number.MAX_SAFE_INTEGER,
  sizeOf: () => 0,
  pathsOf: (artifact) => [artifact.pngPath],
});

// Relay's own ring (issue #96), separate from Capture's — a Relay picker must
// never arrow onto a screenshot, and vice versa. This one IS byte-bounded:
// clipboard images run to tens of MB, so the budget caps how much retained disk
// the ring can pin at once (~three large images) rather than letting ten balloon
// it. A text entry is sized by its byte length; an image by its PNG file on disk
// (best-effort — a missing/unreadable file counts as 0, never throwing here).
const RELAY_HISTORY_BYTE_BUDGET = 64 * 1024 * 1024;
const relayHistory = createCaptureHistory<RelayArtifact>({
  maxBytes: RELAY_HISTORY_BYTE_BUDGET,
  sizeOf: (artifact) =>
    artifact.kind === "text"
      ? artifact.preview.byteSize
      : safeFileSize(artifact.artifact.pngPath),
  pathsOf: (artifact) => relayArtifactPaths(artifact),
});

function safeFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// A capture/relay file is retained — exempt from the TTL sweep — exactly as long
// as EITHER history ring can still arrow to it (issue #93's seam). Both rings are
// OR-ed so wiring the second never masks the first. Evicting an entry drops its
// paths, which is what lets the sweep reclaim them next tick.
function isCaptureRetained(filePath: string): boolean {
  return isRetainedByAny([captureHistory, relayHistory], filePath);
}

function sweepCapturesBestEffort(): void {
  void sweepExpiredCaptures({ isRetained: isCaptureRetained }).catch((error) => {
    // A sweep failure must never crash or interrupt anything — same best-effort
    // posture as the fleet poll. Log and let the next tick try again.
    console.error("[mistr-flow] capture sweep failed:", error);
  });
}

function startCaptureSweeping(): void {
  if (captureSweepTimer) return;
  sweepCapturesBestEffort();
  captureSweepTimer = setInterval(sweepCapturesBestEffort, CAPTURE_SWEEP_INTERVAL_MS);
}

/**
 * The fleet posture is an expression of the *resting* bar only. During any
 * verb the mascot does verb things (and a refusal notice owns the bar until it
 * self-clears), so posture is rendered solely when nothing else holds the
 * overlay. Polling itself never pauses — this only gates the render.
 */
function overlayIsResting(): boolean {
  return verbLock.activeVerb() === null && refusedReturnTimer === null;
}

function renderFleetPosture(posture: FleetPosture): void {
  if (!overlayIsResting()) return;
  sendToRenderer(
    "overlay-state",
    buildFleetPostureOverlaySnapshot(posture.tier, posture.doneCount),
  );
}

async function pollFleetOnce(): Promise<void> {
  const result = await queryWatchedSet({});
  const posture =
    result.kind === "watched"
      ? fleetState.observe({ kind: "panes", agents: result.agents }, Date.now())
      : fleetState.observe({ kind: "unavailable" }, Date.now());
  renderFleetPosture(posture);
  await maybeChimeFleet(posture);
}

// The fleet-awareness foreground seam (ADR 0006 §3, shared by both cues since
// ADR 0007): "is Herdr's host window the OS foreground window right now?"
// Created lazily so a missing socket at startup doesn't matter — identification
// re-reads the socket path per attempt.
let herdrForegroundCheck: IsHerdrForeground | null = null;
function isHerdrForeground(): Promise<boolean> {
  if (herdrForegroundCheck === null) {
    herdrForegroundCheck = createHerdrForegroundCheck({
      readSocketPath: () => readHerdrSocketPath(),
    });
  }
  return herdrForegroundCheck();
}

/**
 * The two active cues of fleet awareness (ADR 0007, amending ADR 0006 §§2–3):
 * when a block passes its dwell or a done episode begins, and Herdr's host
 * window is not the OS foreground window at that poll, sound that state's chime
 * — a double beep for blocked, one soft tone for done.
 *
 * The foreground gate is evaluated exactly once, at the transition poll: Herdr
 * being foreground *consumes* the chime for that episode (fleetState's one-shot
 * is already spent), never deferring it to a later alt-tab. Config- and
 * verb-gated; suppression silences the sound only, never the state.
 */
async function maybeChimeFleet(posture: FleetPosture): Promise<void> {
  // Cheap gates first, for BOTH cues: nothing newly signalled, the cue disabled,
  // or a verb active all short-circuit before the foreground probe — which shells
  // out to PowerShell (the same spawn class #72 fixed), so it must never run for
  // a chime we'd have suppressed anyway (e.g. every episode under
  // `doneChime: false`), and must run at most ONCE per poll even when both cues
  // are live.
  const verbActive = verbLock.activeVerb() !== null;
  const blockedPending =
    posture.newlyBlockedTargets.length > 0 && blockedChime && !verbActive;
  const donePending = posture.newlyDoneTargets.length > 0 && doneChime && !verbActive;
  if (!blockedPending && !donePending) return;

  const herdrForeground = await isHerdrForeground();
  // Re-read the verb lock: the probe is async, so a verb that started during it
  // must still suppress the cue.
  const verbActiveNow = verbLock.activeVerb() !== null;

  // Blocked outranks done when both fire on the same poll (ADR 0006 §4, ADR
  // 0007): a bottleneck outranks a harvest, and two beep shell-outs racing each
  // other interleave into noise rather than two legible cues. The swallowed
  // completion is the same accepted edge as foreground suppression — the done
  // badge and the jump gesture remain the durable surface.
  if (
    shouldChime({
      newlyTargets: posture.newlyBlockedTargets,
      chimeEnabled: blockedChime,
      verbActive: verbActiveNow,
      herdrForeground,
    })
  ) {
    playBlockedChime();
    return;
  }

  if (
    shouldChime({
      newlyTargets: posture.newlyDoneTargets,
      chimeEnabled: doneChime,
      verbActive: verbActiveNow,
      herdrForeground,
    })
  ) {
    playDoneChime();
  }
}

function startFleetPolling(): void {
  if (fleetPollTimer) return;
  void pollFleetOnce();
  fleetPollTimer = setInterval(() => {
    void pollFleetOnce().catch((error) => {
      // A poll should never crash the timer — an unreachable Herdr is already
      // modelled as the `unknown` posture, so anything reaching here is a bug
      // we log and shrug off rather than let kill ambient awareness.
      console.error("[mistr-flow] fleet poll failed:", error);
    });
  }, FLEET_POLL_INTERVAL_MS);
}

// The jump gesture (issue #50, PRD #44; redefined by #79 / ADR 0006 §4): one
// keypress takes you to what most needs you next. The cursor holds where the
// last press landed so repeat presses cycle through the unified attention cycle
// — blocked oldest-first, then done oldest-first; attentionCycle(posture())
// supplies that live order at the moment of each press.
const jumpCursor = createBlockedJumpCursor();

/**
 * Focus the next attention target's pane and raise Herdr's host window, reusing
 * the proven focus/raise machinery (ADR 0002, focusHerdrPane). Repeat presses
 * walk the unified cycle (blocked oldest-first, then done oldest-first); with an
 * empty fleet this is a truthful no-op. Focus-steal here is intentional and
 * user-initiated — you pressed the key to go there — the same explicit exception
 * to "never steal focus" as focusOnDeliver.
 */
function jumpToNextAttentionTarget(): void {
  const target = jumpCursor.next(attentionCycle(fleetState.posture()));
  if (target === null) return; // Nothing needs you — nowhere to jump, so no-op.

  void focusHerdrPane(target)
    .then((outcome) => {
      if (outcome.kind === "focus-failed") {
        // The remembered target likely closed since the poll. The cursor
        // re-anchors to the oldest on the next press, so a follow-up press
        // skips the dead pane rather than stranding the user.
        console.warn("[mistr-flow] jump-to-blocked: could not focus", target);
        return;
      }
      if (outcome.raise.kind === "raised") {
        console.log("[mistr-flow] jump-to-blocked: raised herdr window", outcome.raise.hwnd);
      } else {
        console.warn(
          "[mistr-flow] jump-to-blocked: pane focused but window not raised:",
          outcome.raise.code,
        );
      }
    })
    .catch((error) => {
      console.error("[mistr-flow] jump-to-blocked failed:", error);
    });
}

function applyCaptureWindowBounds(snapshot: OverlaySnapshot): void {
  if (!overlayWindow || overlayWindow.isDestroyed() || !captureRestingBounds) return;

  if (snapshot.phase === "capture-picker") {
    // One height for every verb's picker: slot 1 is the local outcome in all
    // of them since #64 (Capture/Relay "Clipboard", Herald "Paste here"), so
    // the old Relay-specific height alias no longer models anything.
    const bounds = resolveGrownWindowBounds({
      restingBounds: captureRestingBounds,
      grownHeight: capturePickerWindowHeight(
        snapshot.captureTargets?.length ?? 0,
        Boolean(snapshot.capturePreview),
        Boolean(snapshot.againRow),
      ),
      workArea: screen.getPrimaryDisplay().workArea,
    });
    overlayWindow.setBounds(bounds);
    return;
  }

  if (CAPTURE_WINDOW_RESTORE_PHASES.has(snapshot.phase)) {
    overlayWindow.setBounds(captureRestingBounds);
  }
}

function showCaptureOverlay(snapshot: OverlaySnapshot): void {
  sendToRenderer("overlay-state", snapshot);
  applyCaptureWindowBounds(snapshot);
}

function beep(): void {
  execFile(
    "powershell",
    ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "[console]::beep(900,120)"],
    () => {
      // Best-effort cue only — failures here shouldn't interrupt dictation.
    },
  );
}

function bloop(): void {
  execFile(
    "powershell",
    ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "[console]::beep(500,120)"],
    () => {
      // Best-effort cue only — failures here shouldn't interrupt dictation.
    },
  );
}

function simulatePasteKeystroke(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 50; [System.Windows.Forms.SendKeys]::SendWait('^v')",
      ],
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/**
 * Sends Ctrl+C to the foreground app so a *selection* lands on the clipboard
 * before Relay reads it (config `copySelectionFirst`). Best-effort: a failure
 * just means the existing clipboard is relayed, which the preview surfaces.
 * The overlay is non-focusable, so focus stays on the app being copied from.
 */
function simulateCopyKeystroke(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')",
      ],
      () => resolve(),
    );
  });
}

/**
 * Sends an arbitrary SendKeys string to the foreground window — the composer-
 * focus keystroke for an app target (`pasteFocusKeys`). Generalizes the copy/
 * paste keystroke helpers above. Single quotes are doubled so a stray quote in
 * config can't break the single-quoted PowerShell string (per-machine config is
 * trusted, so this is robustness, not a security boundary).
 */
function sendKeysRaw(keys: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`,
      ],
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/** A cheap clipboard fingerprint, to detect when a simulated copy has landed. */
function clipboardSignature(): string {
  const text = clipboard.readText();
  if (text) return `t:${text.length}:${text.slice(0, 64)}`;
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const size = image.getSize();
    return `i:${size.width}x${size.height}`;
  }
  return `f:${readClipboardFilePath() ?? ""}`;
}

/**
 * Simulates a copy, then waits (briefly) for the clipboard to actually change,
 * so Relay reads the freshly-copied selection rather than the pre-copy content.
 * If it never changes within the window — nothing was selected, or the
 * selection already equalled the clipboard — we proceed with what's there; the
 * preview shows the truth either way.
 */
async function copySelectionIntoClipboard(): Promise<void> {
  const before = clipboardSignature();
  await simulateCopyKeystroke();

  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30));
    if (clipboardSignature() !== before) return;
  }
}

function requestStopRecording(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for recorded audio from the overlay renderer.")),
      5000,
    );
    ipcMain.once("recording-stopped", (_event, arrayBuffer: ArrayBuffer) => {
      clearTimeout(timeout);
      resolve(Buffer.from(arrayBuffer));
    });
    sendToRenderer("stop-recording");
  });
}

/**
 * Opens one recording session — the modal microphone half shared by Dictation
 * and Herald (issue #55): the audio promise the toggle/Esc handlers settle,
 * system-audio muting, the session Escape shortcut, and the renderer's
 * start-recording cue. Returns the audio promise, or null when a recording
 * session is already active.
 */
function startRecordingSession(verb: "dictation" | "herald"): Promise<Buffer> | null {
  if (activeSession) return null;

  let resolveAudio!: (buffer: Buffer) => void;
  let rejectAudio!: (error: Error) => void;
  const audioPromise = new Promise<Buffer>((resolve, reject) => {
    resolveAudio = resolve;
    rejectAudio = reject;
  });

  const systemAudioMutePromise = muteSystemAudioForRecording();
  let session!: ActiveSession;
  const idleReturn = createSessionIdleReturn({
    isActive: () => activeSession === session,
    hasActiveSession: () => activeSession !== null,
    sendIdle: () => sendToRenderer("overlay-state", buildOverlaySnapshot("idle")),
    setTimeout,
  });
  session = { verb, resolveAudio, rejectAudio, systemAudioMutePromise, cleanupPromise: null, idleReturn };
  activeSession = session;
  globalShortcut.register("Escape", () => {
    if (activeSession) endSession("escape");
  });
  sendToRenderer("start-recording");
  return audioPromise;
}

function startSession(): void {
  if (!aiProvider) return;
  const provider = aiProvider;

  const audioPromise = startRecordingSession("dictation");
  if (!audioPromise) return;
  const session = activeSession!;

  void runDictationSession({
    showOverlay: (snapshot) => sendToRenderer("overlay-state", snapshot),
    playBeep: () => beep(),
    recordAudio: () => audioPromise,
    transcribe: (buffer) => provider.transcribe(buffer, { vocabularyPrompt: whisperVocabularyPrompt }),
    polish: (rawTranscript) => provider.polish(rawTranscript, { vocabularyInstruction: polishVocabularyInstruction }),
    pasteText: (text) =>
      pasteTextImpl(text, {
        writeClipboard: (t) => clipboard.writeText(t),
        simulatePaste: () => simulatePasteKeystroke(),
      }),
  })
    .then((result) => console.log("[mistr-flow] session result:", result.kind))
    .catch((error) => console.error("[mistr-flow] dictation session failed:", error))
    .finally(() => session.idleReturn.schedule());
}

async function muteSystemAudioForRecording(): Promise<SystemAudioMuteHandle | null> {
  if (!muteSystemAudioWhileRecording) return null;

  try {
    return await muteSystemAudio();
  } catch (error) {
    console.warn("[mistr-flow] failed to mute system audio while recording:", error);
    return null;
  }
}

async function restoreSystemAudioAfterRecording(
  mutePromise: Promise<SystemAudioMuteHandle | null>,
): Promise<void> {
  try {
    const handle = await mutePromise;
    await handle?.restore();
  } catch (error) {
    console.warn("[mistr-flow] failed to restore system audio after recording:", error);
  }
}

function beginSessionCleanup(session: ActiveSession, cleanup: Promise<void>): void {
  if (session.cleanupPromise) return;

  globalShortcut.unregister("Escape");
  session.cleanupPromise = cleanup.finally(() => {
    if (activeSession === session) activeSession = null;
    // Dictation's lock guards only the recording (processing/paste are
    // non-modal). Herald's lock guards the WHOLE routed session — the picker
    // is modal — so it is released by startHerald's finally, never here.
    if (session.verb === "dictation") verbLock.release("dictation");
    session.idleReturn.afterCleanup();

    if (quitAfterSessionCleanup) {
      quitAfterSessionCleanup = false;
      app.quit();
    }
  });
}

function endSession(reason: "release" | "escape"): void {
  if (!activeSession) return;
  const session = activeSession;
  const { resolveAudio, rejectAudio, systemAudioMutePromise } = session;
  if (session.cleanupPromise) return;

  if (reason === "escape") {
    sendToRenderer("cancel-recording");
    rejectAudio(createDictationCancelledError("escape"));
    beginSessionCleanup(session, restoreSystemAudioAfterRecording(systemAudioMutePromise));
    return;
  }

  bloop();
  beginSessionCleanup(session, requestStopRecording()
    .then(resolveAudio)
    .catch(rejectAudio)
    .finally(() => restoreSystemAudioAfterRecording(systemAudioMutePromise)));
}

const TOGGLE_ACCELERATOR = "Control+Alt+D";

function registerHotkey(): void {
  const registered = globalShortcut.register(TOGGLE_ACCELERATOR, () => {
    // Toggle-stop only dictation's OWN recording. A Herald recording is not
    // this verb's to stop — that press falls through to the verb lock and
    // refuses, so active dictation (either verb's) is never interrupted.
    if (activeSession?.verb === "dictation") {
      endSession("release");
      return;
    }

    // A different verb's OPEN PICKER yields to this key (verb switch,
    // 2026-07-17): a picker is a menu, not work. Busy states still refuse.
    if (
      decideVerbStart(
        { activeVerb: verbLock.activeVerb(), pickerOpen: activeAgainEmit !== null },
        "dictation",
      ) === "switch"
    ) {
      requestVerbSwitch("dictation", startSession);
      return;
    }

    if (!verbLock.tryStart("dictation")) {
      refuseOrForceSwitch("dictation", startSession);
      return;
    }

    cancelRefusedReturn();
    startSession();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${TOGGLE_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
}

// Control+Alt+S ("S for screenshot", 2026-07-17) — joining the Ctrl+Alt
// family the other verbs live in (D dictate, C relay, H herald, J jump); the
// original Control+Shift+` predated the family. Same loud-collision contract
// as the rest: registration failure surfaces in a dialog, never a silent swap.
const CAPTURE_ACCELERATOR = "Control+Alt+S";

function registerCaptureHotkey(): void {
  const registered = globalShortcut.register(CAPTURE_ACCELERATOR, () => {
    // The verb's own hotkey again, while its own picker is open, is the
    // Same-agent-again confirm (issue #58, ADR 0004) — routed into the
    // picker's selection stream; the session resolves it against the live
    // again-row or absorbs it as a truthful no-op. Any other mid-flight
    // press (own grab still in progress, another verb active) still lands
    // on the verb lock below and gets the mascot refusal.
    if (verbLock.activeVerb() === "capture" && activeAgainEmit) {
      activeAgainEmit();
      return;
    }

    // A different verb's OPEN PICKER yields to this key (verb switch,
    // 2026-07-17): a picker is a menu, not work. Busy states still refuse.
    if (
      decideVerbStart(
        { activeVerb: verbLock.activeVerb(), pickerOpen: activeAgainEmit !== null },
        "capture",
      ) === "switch"
    ) {
      requestVerbSwitch("capture", startCapture);
      return;
    }

    if (!verbLock.tryStart("capture")) {
      refuseOrForceSwitch("capture", startCapture);
      return;
    }

    cancelRefusedReturn();
    startCapture();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${CAPTURE_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
}

// Ctrl+Alt+C ("clipboard"), matching Ctrl+Alt+D ("dictate"). Pre-verified live
// on the home machine (2026-07-15, issue #39): registers cleanly via
// globalShortcut with no hard conflict. Do not swap it out speculatively — the
// residual risk (globalShortcut intercepts system-wide) is covered by the human
// verification issue (#40).
const RELAY_ACCELERATOR = "Control+Alt+C";

function registerRelayHotkey(): void {
  const registered = globalShortcut.register(RELAY_ACCELERATOR, () => {
    // Ctrl+Alt+C → picker → Ctrl+Alt+C: the again-confirm while Relay's own
    // picker is open (issue #58) — see registerCaptureHotkey.
    if (verbLock.activeVerb() === "relay" && activeAgainEmit) {
      activeAgainEmit();
      return;
    }

    // A different verb's OPEN PICKER yields to this key (verb switch,
    // 2026-07-17): a picker is a menu, not work. Busy states still refuse.
    if (
      decideVerbStart(
        { activeVerb: verbLock.activeVerb(), pickerOpen: activeAgainEmit !== null },
        "relay",
      ) === "switch"
    ) {
      requestVerbSwitch("relay", startRelay);
      return;
    }

    if (!verbLock.tryStart("relay")) {
      refuseOrForceSwitch("relay", startRelay);
      return;
    }

    cancelRefusedReturn();
    startRelay();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${RELAY_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
}

// Ctrl+Alt+H ("H for Herdr"), beside D (dictate) and C (clipboard) in the
// Ctrl+Alt+ family (issue #55, ADR 0003): dictation's front half routed to an
// agent pane through the send session, instead of pasted locally. Like every
// other hotkey it fails loudly on a live OS-wide collision (dialog in
// whenReady), never silently swapped; live-desktop behavior is the human
// sibling issue (#56).
const HERALD_ACCELERATOR = "Control+Alt+H";

function registerHeraldHotkey(): void {
  const registered = globalShortcut.register(HERALD_ACCELERATOR, () => {
    // Toggle-stop only Herald's OWN recording — mirroring Ctrl+Alt+D. The
    // toggle outranks the again-confirm: while recording there is no picker,
    // and the second press already means "stop" (ADR 0004 rejected
    // double-tap for exactly this collision).
    if (activeSession?.verb === "herald") {
      endSession("release");
      return;
    }

    // Ctrl+Alt+H → picker → Ctrl+Alt+H: the again-confirm while Herald's own
    // picker is open (issue #58) — see registerCaptureHotkey. Mid-polish
    // (verb active, no picker yet) still falls through to the refusal.
    if (verbLock.activeVerb() === "herald" && activeAgainEmit) {
      activeAgainEmit();
      return;
    }

    // A different verb's OPEN PICKER yields to this key (verb switch,
    // 2026-07-17): a picker is a menu, not work. Busy states still refuse.
    if (
      decideVerbStart(
        { activeVerb: verbLock.activeVerb(), pickerOpen: activeAgainEmit !== null },
        "herald",
      ) === "switch"
    ) {
      requestVerbSwitch("herald", startHerald);
      return;
    }

    if (!verbLock.tryStart("herald")) {
      refuseOrForceSwitch("herald", startHerald);
      return;
    }

    cancelRefusedReturn();
    startHerald();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${HERALD_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
}

// Ctrl+Alt+J ("jump"), matching the Ctrl+Alt+ family (D dictate, C clipboard).
// Chosen to avoid the three existing hotkeys (Ctrl+Alt+D, Ctrl+Shift+`,
// Ctrl+Alt+C) and, unlike the Shift+capital-letter lesson, uses no shifted
// letter so it can't fire on an ordinary keypress. globalShortcut.register
// returns false on a live OS-wide collision — reported (dialog.showErrorBox in
// whenReady), never silently swapped, so the collision surfaces for the human
// verification slice rather than hiding.
const JUMP_ACCELERATOR = "Control+Alt+J";

function registerJumpHotkey(): void {
  const registered = globalShortcut.register(JUMP_ACCELERATOR, () => {
    jumpToNextAttentionTarget();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${JUMP_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
}

// Ctrl+Alt+V ("V" for the Ctrl+V muscle memory, issue #101) — the paste verb,
// joining the Ctrl+Alt family (D dictate, S screenshot, C copy, H herald, J
// jump). It pastes a Mistr Flow capture into whatever window has focus. No
// numpad twin: V is a top-row letter with no keypad equivalent (unlike the
// picker digits). Same loud-collision contract as the rest — a failed
// registration surfaces in a dialog (whenReady), never a silent swap.
const PASTE_ACCELERATOR = "Control+Alt+V";

function registerPasteHotkey(): void {
  const registered = globalShortcut.register(PASTE_ACCELERATOR, () => {
    // While ANY picker is open (Capture or Relay), Ctrl+Alt+V pastes the
    // ARROWED entry into the foreground and settles that picker as a local
    // success — routed into the picker's selection stream, exactly as the
    // again-confirm routes the verb's own key. `activePasteEmit` is non-null
    // for precisely the picker's lifetime (the handle unsubscribes on close).
    if (activePasteEmit) {
      activePasteEmit();
      return;
    }

    // A modal verb is mid-flight with no picker to route into (recording,
    // pre-picker grab, mid-polish): don't clobber it. Same visible mascot
    // refusal the other verbs give — never a silent no-op. (During delivering
    // the picker is still subscribed, so a press there lands on activePasteEmit
    // above and is a structural no-op, exactly like a digit press.)
    if (verbLock.activeVerb() !== null) {
      refuseVerb();
      return;
    }

    // Bare hotkey, nothing else in flight: paste the NEWEST capture-ring entry
    // into the foreground window (empty ring → truthful refusal).
    startForegroundPaste();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${PASTE_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
}

/**
 * The picker's target query, dressed with Project Anchors (2026-07-17): each
 * pane's cwd resolves against the per-machine `projectAnchors` config so the
 * renderer can draw the WHERE glyph + friendly name without owning path
 * logic. Presentation only — the herdr adapter stays ignorant of projects,
 * and a miss changes nothing (the row falls back to its raw label).
 */
function queryAnchoredTargets(): ReturnType<typeof queryHerdr> {
  const apps = appTargets.map(appTargetToEligibleTarget);
  return queryHerdr({}).then((result) =>
    // The pure composer (src/pickerTargets.ts) merges the live panes with the
    // config app targets: panes keep the low digits (anchored here), apps append
    // after, and — crucially — the apps survive a Herdr-down poll so they (and an
    // app Last Target's again-row) never vanish just because Herdr is unreachable.
    composePickerTargets(result, apps, (target): AnchoredTarget => {
      const anchor = resolveProjectAnchor(target.cwd, projectAnchors);
      return anchor ? { ...target, anchor } : target;
    }),
  );
}

function grabActiveWindow(): Promise<CaptureArtifact> {
  const excludeHwnd = overlayWindow
    ? nativeWindowHandleToHwnd(overlayWindow.getNativeWindowHandle())
    : undefined;

  return captureActiveWindowImpl({ excludeHwnd }).then((result) => {
    if (result.kind === "capture-failed") {
      throw createCaptureGrabFailedError(result.code, result.message);
    }
    return result.artifact;
  });
}

function copyCaptureToClipboard(artifact: CaptureArtifact): void {
  clipboard.writeImage(nativeImage.createFromPath(artifact.pngPath));
}

/**
 * Adapts Electron's `nativeImage` to the pure module's port. `resize` returns
 * a fresh NativeImage, so wrapping on the way out keeps the chain typed
 * without leaking Electron into captureThumbnail.ts.
 */
function toThumbnailPort(image: NativeImage): ThumbnailImagePort {
  return {
    getSize: () => image.getSize(),
    resize: (size) => toThumbnailPort(image.resize(size)),
    toDataURL: () => image.toDataURL(),
    isEmpty: () => image.isEmpty(),
  };
}

async function renderCaptureThumbnail(
  artifact: CaptureArtifact,
): Promise<CapturePreview | null> {
  return renderCapturePreview(
    (pngPath) => toThumbnailPort(nativeImage.createFromPath(pngPath)),
    artifact,
  );
}

/** Adapts `nativeImage` to the crop port, mirroring toThumbnailPort. */
function toCropPort(image: NativeImage): CropImagePort {
  return {
    getSize: () => image.getSize(),
    crop: (rect) => toCropPort(image.crop(rect)),
    toPNG: () => image.toPNG(),
    isEmpty: () => image.isEmpty(),
  };
}

/**
 * Writes the cropped pixels as a fresh capture — new id and new file, because
 * a crop really is a different capture: delivery injects a path, and the
 * delivery ledger keys idempotency on (id, path, target). Reusing the id
 * would make a post-crop retry look like a mismatched replay of the original.
 * The new file lands beside the original and is swept by the same TTL.
 */
async function cropCaptureArtifact(
  artifact: CaptureArtifact,
  rect: CropRect,
): Promise<CaptureArtifact | null> {
  const png = cropCaptureImage(
    (pngPath) => toCropPort(nativeImage.createFromPath(pngPath)),
    artifact.pngPath,
    rect,
  );
  if (!png) return null;

  try {
    const id = randomUUID();
    const croppedPath = path.join(path.dirname(artifact.pngPath), `${id}.png`);
    await fs.promises.writeFile(croppedPath, png);
    return { ...artifact, id, pngPath: croppedPath };
  } catch (error) {
    console.warn("[mistr-flow] capture crop: failed to write cropped png:", error);
    return null;
  }
}

// Crop drags arrive from the renderer over IPC; the active picker handle
// subscribes here so they join the same selection stream as the digits.
let activeCropEmit: ((rect: CropRect) => void) | null = null;

const captureCropSource: CropSource = (emit) => {
  activeCropEmit = emit;
  return () => {
    if (activeCropEmit === emit) activeCropEmit = null;
  };
};

// History navigation (issues #95/#96), shared by both verbs' pickers — the verb
// lock guarantees at most one is open, so one source suffices. Passing it is what
// makes the picker register the Left/Right `globalShortcut`s (the real arrow
// input), so the emit hook stays dormant in production (the arrows resolve
// directly in the handle) and exists so navigation is drivable from tests without
// a keyboard, mirroring the crop/again seams.
let activeHistoryEmit: ((direction: "older" | "newer") => void) | null = null;

const pickerHistorySource: HistorySource = (emit) => {
  activeHistoryEmit = emit;
  return () => {
    if (activeHistoryEmit === emit) activeHistoryEmit = null;
  };
};

// A session's window onto a module-level ring, generic over the entry type so
// Capture and Relay share one wiring rather than forking it (issue #96).
// `navigate` moves the cursor and hands back the entry landed on (never null —
// the session pushes the fresh grab before opening); position counts from the
// newest (newest = 1).
function makeHistoryPort<A>(ring: CaptureHistory<A>): SessionHistoryPort<A> {
  return {
    push: (artifact) => ring.push(artifact),
    navigate: (direction) => {
      if (direction === "older") ring.older();
      else ring.newer();
      return ring.current as A;
    },
    replaceCurrent: (artifact) => ring.replaceCurrent(artifact),
    currentOriginal: () => ring.currentOriginal as A,
    position: () => ({
      current: ring.length - ring.cursorIndex,
      total: ring.length,
    }),
  };
}

// The verb-key again-confirm (issue #58, ADR 0004), mirroring the crop
// source: non-null exactly while a picker is open (the handle unsubscribes on
// close, on every exit path), so `verbLock.activeVerb() === <verb> &&
// activeAgainEmit` in a hotkey handler reads precisely "that verb's own
// picker is open right now" — the verb lock guarantees at most one picker.
let activeAgainEmit: (() => void) | null = null;

const pickerAgainSource: AgainSource = (emit) => {
  activeAgainEmit = emit;
  return () => {
    if (activeAgainEmit === emit) activeAgainEmit = null;
  };
};

// External picker cancel for the verb switch (2026-07-17), mirroring the
// again hook: non-null exactly while a picker is open, so a different verb's
// hotkey can dismiss it through the picker's own escape channel instead of
// trapping the user behind a manual Esc (which, mis-aimed, lands in the
// focused pane and kills real coding sessions).
let activeCancelEmit: (() => void) | null = null;

const pickerCancelSource: CancelSource = (emit) => {
  activeCancelEmit = emit;
  return () => {
    if (activeCancelEmit === emit) activeCancelEmit = null;
  };
};

// Paste-to-foreground (Ctrl+Alt+V, issue #101), mirroring the again hook:
// non-null exactly while a picker is open, so the standalone Ctrl+Alt+V hotkey
// routes into the OPEN picker (pasting the arrowed entry) instead of the bare
// newest-capture path. Both the Capture and Relay picker builds wire this
// source, and the verb lock guarantees at most one picker is open.
let activePasteEmit: (() => void) | null = null;

const pickerPasteSource: PasteSource = (emit) => {
  activePasteEmit = emit;
  return () => {
    if (activePasteEmit === emit) activePasteEmit = null;
  };
};

/**
 * The verb switch (2026-07-17): cancel the open picker, then start the
 * intended verb the moment the lock frees — one press, no Esc, no trap. The
 * cancelled session unwinds asynchronously (its finally releases the lock),
 * so this retries briefly; if the lock somehow never frees, the switch
 * dissolves rather than queueing stale intent.
 */
function requestVerbSwitch(verb: Verb, start: () => void): void {
  const deadline = Date.now() + 4000;
  const attempt = (): void => {
    if (verbLock.tryStart(verb)) {
      cancelRefusedReturn();
      start();
      return;
    }
    // Cancel whatever is cancellable *right now*, then keep trying: an open
    // picker (its escape channel), or a mistaken recording (the exact path
    // Esc takes — endSession no-ops when there's nothing to cancel).
    // Un-cancellable phases (delivering, mid-polish) simply run out on their
    // own and the switch lands when the lock frees — spoken words in flight
    // are pasted first, never lost. Past the deadline the switch dissolves
    // rather than queueing stale intent.
    activeCancelEmit?.();
    endSession("escape");
    if (Date.now() > deadline) return;
    setTimeout(attempt, 50);
  };
  attempt();
}

/**
 * The double-press escape hatch (2026-07-17): a busy state's first foreign
 * press wags — protecting a real recording from an accidental brush — but the
 * SAME intended key again inside this window means "I mean it": switch, using
 * every cancel requestVerbSwitch knows. This is the fix for "stuck until Esc,
 * and Esc kills coding sessions" — the intended key itself becomes the exit.
 */
const REPEAT_SWITCH_WINDOW_MS = 3000;
let lastRefusedVerb: { verb: Verb; atMs: number } | null = null;

function refuseOrForceSwitch(verb: Verb, start: () => void): void {
  const now = Date.now();
  if (
    lastRefusedVerb &&
    lastRefusedVerb.verb === verb &&
    now - lastRefusedVerb.atMs < REPEAT_SWITCH_WINDOW_MS
  ) {
    lastRefusedVerb = null;
    requestVerbSwitch(verb, start);
    return;
  }
  lastRefusedVerb = { verb, atMs: now };
  refuseVerb();
}

// Row clicks from the renderer (issue #61, ADR 0005), mirroring the crop
// source: a click on a key-cap row arrives over IPC carrying the row's
// identity and joins the same selection stream as the digits — the handle
// dispatches the exact event the row's key would. Non-null exactly while a
// picker is open (the handle unsubscribes on close, on every exit path),
// which doubles as the pure bar-click gate's "picker open" input below.
let activeRowClickEmit: ((click: PickerRowClick) => void) | null = null;

const pickerRowClickSource: RowClickSource = (emit) => {
  activeRowClickEmit = emit;
  return () => {
    if (activeRowClickEmit === emit) activeRowClickEmit = null;
  };
};

/** The hotkey text the again-row shows — Electron's "Control" reads "Ctrl" on the row. */
function hotkeyLabelFor(accelerator: string): string {
  return accelerator.replace("Control", "Ctrl");
}

// Same agent again (issue #58, ADR 0004): ONE Last Target across all three
// send verbs — in-process only, no expiry, dies with the app. Wrapping the
// shared delivery adapter below is what keeps it verb-agnostic: every verb's
// confirmed delivered ack records here, and slot-1 outcomes structurally
// never reach it (they don't go through deliver at all).
const lastTargetMemory = createLastTargetMemory();

// Electron-backed ports for app-target delivery (ChatGPT-as-target, 2026-07-17):
// clipboard write (image|text) + Ctrl+V, with an optional composer-focus
// keystroke. The window-focus port defaults to the real focusAppWindow inside
// the adapter, so it isn't wired here; pathExists/readTextFile default to fs.
const appDeliveryPorts: AppDeliveryDeps = {
  writeImageToClipboard: (pngPath) =>
    clipboard.writeImage(nativeImage.createFromPath(pngPath)),
  writeTextToClipboard: (text) => clipboard.writeText(text),
  simulatePaste: () => simulatePasteKeystroke(),
  sendKeys: (keys) => sendKeysRaw(keys),
  // Focus-settle before the paste (#99): a real setTimeout sleep so a webview
  // app (ChatGPT) routes input into its composer before Ctrl+V fires. Distinct
  // from simulatePasteKeystroke's shared 50 ms — that one stays untouched.
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// One adapter instance for the app's lifetime: the Herdr AND app delivery
// ledgers must persist across a session's unknown → retry digit presses (#32),
// so the router that owns both is built once and rebuilt once at startup when
// config (focusOnDeliver) is known — see whenReady. withLastTargetRecording
// wraps the ROUTER, so a delivered ChatGPT paste records ChatGPT as the shared
// Last Target and "again" repeats to it, for free.
function buildDeliverCapture(focusOnDeliver: boolean) {
  return withLastTargetRecording(
    createRoutingDeliveryAdapter({
      herdr: createHerdrDeliveryAdapter({ focusOnDeliver }),
      app: createAppDeliveryAdapter(appDeliveryPorts),
    }),
    lastTargetMemory,
  );
}

let deliverCapture = buildDeliverCapture(false);

// The current foreground window as a delivery target (Ctrl+Alt+V, issue #101):
// an app target with no window matcher — the foreground IS the target, so the
// adapter writes the clipboard and pastes with NO focus step. The pane fields
// are inert placeholders (like an app target's). Routed through `deliverCapture`
// so it reuses the app adapter's ledger and flavor logic; withLastTargetRecording
// skips `kind:"foreground"`, so this local outcome never becomes the Last Target.
const FOREGROUND_TARGET: EligibleTarget = {
  target: "foreground",
  label: "the foreground window",
  agentStatus: "idle",
  agent: "foreground",
  cwd: null,
  kind: "foreground",
};

/**
 * Deliver a payload to the current foreground window (#101). The caller mints a
 * fresh payload id per paste — the ledger keys on (id, injectText, target), so
 * re-pasting a ring entry with a reused id would return the cached "delivered"
 * while no Ctrl+V ever fired (the #95 trap). Returns the outcome; the bare-path
 * orchestrator branches on it, the in-picker local action discards it.
 */
function deliverToForeground(payload: SendPayload): Promise<CaptureDeliverOutcome> {
  return deliverCapture(payload, FOREGROUND_TARGET);
}

/**
 * Bare Ctrl+Alt+V (#101): paste the NEWEST capture-ring entry into the
 * foreground window. Empty ring → a truthful "nothing captured yet" refusal.
 * A fresh payload id is minted per paste (the #95 discipline).
 */
function startForegroundPaste(): void {
  void runForegroundPaste<CaptureArtifact>({
    entry: () => captureHistory.newest,
    deliver: (artifact) =>
      deliverToForeground(captureArtifactToPayload(artifact, randomUUID())),
    showNothingCaptured: () =>
      showCaptureOverlay(buildPasteNothingCapturedOverlaySnapshot()),
    showPasted: () => showCaptureOverlay(buildOverlaySnapshot("done")),
    showFailed: (message) =>
      showCaptureOverlay(buildCaptureDeliveryFailedOverlaySnapshot(message)),
  }).catch((error) =>
    console.error("[mistr-flow] foreground paste failed:", error),
  );
}

function openCapturePicker(): CapturePickerHandle {
  return createCapturePickerHandle({
    shortcuts: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    cropSource: captureCropSource,
    againSource: pickerAgainSource,
    clickSource: pickerRowClickSource,
    cancelSource: pickerCancelSource,
    historySource: pickerHistorySource,
    pasteSource: pickerPasteSource,
  });
}

function startCapture(): void {
  captureRestingBounds = overlayWindow && !overlayWindow.isDestroyed()
    ? overlayWindow.getBounds()
    : null;

  void runCaptureSession({
    showOverlay: (snapshot) => showCaptureOverlay(snapshot),
    // Push the fresh grab onto the history ring before the picker opens, so the
    // ring's current entry is exactly what the session is standing on (#95).
    captureActiveWindow: async () => {
      const artifact = await grabActiveWindow();
      captureHistory.push(artifact);
      return artifact;
    },
    openPicker: () => openCapturePicker(),
    renderThumbnail: (artifact) => renderCaptureThumbnail(artifact),
    cropCapture: (artifact, rect) => cropCaptureArtifact(artifact, rect),
    queryEligibleTargets: () => queryAnchoredTargets(),
    copyToClipboard: (artifact) => copyCaptureToClipboard(artifact),
    // Mint a fresh payload id per delivery (#95): the ledger keys idempotency on
    // (id, injectText, target) and caches the outcome, so re-delivering a history
    // entry to a pane it already went to would silently no-op. A fresh id keeps
    // the file/pane stable while making each send a distinct ledger key.
    deliver: (capture, target) =>
      deliverCapture(captureArtifactToPayload(capture, randomUUID()), target),
    // Ctrl+Alt+V while this picker is open (#101): paste the arrowed entry into
    // the foreground window — a LOCAL outcome, so it never updates the Last
    // Target. Fresh payload id per paste, same #95 ledger discipline as deliver.
    pasteToForeground: (capture) =>
      deliverToForeground(captureArtifactToPayload(capture, randomUUID())).then(
        () => undefined,
      ),
    history: makeHistoryPort(captureHistory),
    // Same agent again (issue #58): the shared Last Target, keyed to this
    // verb's own hotkey — pressed again while the picker is open, it confirms.
    again: {
      readLastTarget: () => lastTargetMemory.current(),
      hotkeyLabel: hotkeyLabelFor(CAPTURE_ACCELERATOR),
    },
  })
    .then((result) => console.log("[mistr-flow] capture session result:", result.kind))
    .catch((error) => console.error("[mistr-flow] capture session failed:", error))
    .finally(() => {
      verbLock.release("capture");
      captureRestingBounds = null;
    });
}

// Relay reads/PNG-spills into the same temp dir captures use, so the TTL sweep
// (startCaptureSweeping) reclaims relay spill/image files too (CONTEXT.md).
const relayCaptureDir = defaultCaptureDir();

/** Adapts Electron's clipboard + fs to the pure Relay source port (issue #38). */
/**
 * The absolute path of a file copied in Explorer, or null.
 *
 * Verified live (2026-07-15) against a copied `.py`: `availableFormats()` is
 * `["text/uri-list"]`, `readText()` is empty and `readImage()` is empty — a
 * file copy sets neither — while `readBuffer("FileNameW")` carries the full
 * path as UTF-16LE with a trailing NUL. Without this, a copied file reads as
 * an empty clipboard and Relay truthfully says it has nothing to send.
 *
 * `FileName` (the ANSI 8.3 sibling) is deliberately ignored: it's lossy, and
 * `FileNameW` is present alongside it.
 */
function readClipboardFilePath(): string | null {
  try {
    const buffer = clipboard.readBuffer("FileNameW");
    if (!buffer || buffer.length === 0) return null;

    const decoded = buffer.toString("utf16le").replace(/\0+$/g, "").trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    // Format absent on this clipboard — not an error, just no file.
    return null;
  }
}

/**
 * Every absolute path of an Explorer file copy — multi-select aware — via a
 * `Get-Clipboard -Format FileDropList` shell-out (issue #67), the same house
 * pattern as beep/paste/copy above.
 *
 * A shell-out, because Electron's clipboard API cannot read a Windows file
 * drop (verified live 2026-07-16, Electron 42): `readBuffer("CF_HDROP")`
 * registers a *custom* format named "CF_HDROP" — the standard format is a
 * numeric id, not a name — so it always comes back empty; and
 * `read`/`readBuffer("text/uri-list")` return `""` even while
 * `availableFormats()` advertises the format. `FileNameW` (above) is the only
 * working native read and carries just the FIRST file by design. `powershell`
 * (5.1), not pwsh: 7 dropped `Get-Clipboard -Format`. UTF-8 is forced on
 * stdout so non-ASCII filenames survive the pipe. Null on any failure or an
 * empty list — the port falls back to `readFilePath`.
 */
function readClipboardFileDropList(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
      ],
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseFileDropListOutput(String(stdout)));
      },
    );
  });
}

/**
 * Cheap, in-process file-drop presence check (issue #90) — gates the
 * `readClipboardFileDropList` shell-out without relying on the legacy
 * `FileNameW` format, which only Explorer is guaranteed to set alongside a
 * file drop. `availableFormats()` advertises `"text/uri-list"` for ANY
 * standard `CF_HDROP` file drop, Explorer-authored or not, even though
 * actually reading that format returns `""` (verified live 2026-07-15,
 * Electron 42 — see `readClipboardFileDropList`'s note on the format).
 */
function clipboardHasFileDrop(): boolean {
  return clipboard.availableFormats().includes("text/uri-list");
}

function relayClipboardPort(): ClipboardSourcePort {
  return {
    readText: () => clipboard.readText(),
    readImage: () => {
      const image = clipboard.readImage();
      return { isEmpty: () => image.isEmpty(), toPNG: () => image.toPNG() };
    },
    readFilePath: () => readClipboardFilePath(),
    hasFileDrop: () => clipboardHasFileDrop(),
    readFileDropList: () => readClipboardFileDropList(),
    writeFile: async (filePath, data) => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, data);
    },
    mintId: () => randomUUID(),
    timestampIso: () => new Date().toISOString(),
    captureDir: relayCaptureDir,
  };
}

function openRelayPicker(): CapturePickerHandle {
  return createCapturePickerHandle({
    shortcuts: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    cropSource: captureCropSource,
    againSource: pickerAgainSource,
    clickSource: pickerRowClickSource,
    cancelSource: pickerCancelSource,
    historySource: pickerHistorySource,
    pasteSource: pickerPasteSource,
    // Slot 1 returned (#64): "1 Clipboard" = keep the copy, stop here — the
    // affirmative local ending now that Ctrl+Alt+C (with copySelectionFirst)
    // is itself the copy. Same digit, same "Clipboard" label as Capture's.
    includeClipboardSlot: true,
  });
}

function startRelay(): void {
  captureRestingBounds = overlayWindow && !overlayWindow.isDestroyed()
    ? overlayWindow.getBounds()
    : null;

  void runRelaySession({
    readClipboardSource: async () => {
      // Opt-in: grab the current selection first (Ctrl+C), so select → hotkey →
      // digit skips an explicit copy. No selection → the copy no-ops and the
      // existing clipboard is read; the preview shows whichever it is.
      if (copySelectionFirst) await copySelectionIntoClipboard();
      return readClipboardSource(relayClipboardPort());
    },
    showOverlay: (snapshot) => showCaptureOverlay(snapshot),
    openPicker: () => openRelayPicker(),
    renderImageThumbnail: (artifact) => renderCaptureThumbnail(artifact),
    cropImage: (artifact, rect) => cropCaptureArtifact(artifact, rect),
    copyToClipboard: (artifact) => copyCaptureToClipboard(artifact),
    queryEligibleTargets: () => queryAnchoredTargets(),
    // Same adapter, same ledger, same ack/unknown-retry semantics, same
    // focusOnDeliver as Capture — Relay's payload just isn't always a PNG.
    deliver: (payload, target) => deliverCapture(payload, target),
    // Ctrl+Alt+V while this picker is open (#101): paste the arrowed entry
    // (image or text) into the foreground window — a LOCAL outcome. The session
    // mints the fresh payload id (via mintId) before handing the payload here.
    pasteToForeground: (payload) => deliverToForeground(payload).then(() => undefined),
    history: makeHistoryPort(relayHistory),
    // Fresh payload id per delivery (#96), same ledger reason as Capture (#95).
    mintId: () => randomUUID(),
    // The same ONE Last Target as Capture and Herald (issue #58, ADR 0004).
    again: {
      readLastTarget: () => lastTargetMemory.current(),
      hotkeyLabel: hotkeyLabelFor(RELAY_ACCELERATOR),
    },
  })
    .then((result) => console.log("[mistr-flow] relay session result:", result.kind))
    .catch((error) => console.error("[mistr-flow] relay session failed:", error))
    .finally(() => {
      verbLock.release("relay");
      captureRestingBounds = null;
    });
}

function startHerald(): void {
  if (!aiProvider) {
    verbLock.release("herald");
    return;
  }
  const provider = aiProvider;

  captureRestingBounds = overlayWindow && !overlayWindow.isDestroyed()
    ? overlayWindow.getBounds()
    : null;

  void runHeraldSession({
    showOverlay: (snapshot) => showCaptureOverlay(snapshot),
    playBeep: () => beep(),
    recordAudio: async () => {
      // Esc in the picker re-dictates (ADR 0003), and the previous take's
      // recording session tears down asynchronously — wait it out so a
      // retake can never race the cleanup.
      await activeSession?.cleanupPromise;
      const audioPromise = startRecordingSession("herald");
      if (!audioPromise) {
        throw new Error("A recording session is already active.");
      }
      return audioPromise;
    },
    transcribe: (buffer) => provider.transcribe(buffer, { vocabularyPrompt: whisperVocabularyPrompt }),
    polish: (rawTranscript) => provider.polish(rawTranscript, { vocabularyInstruction: polishVocabularyInstruction }),
    // Capture's picker exactly: slot 1 registered (Herald relabels it "Paste
    // here" via the snapshot), panes on 2–9 — same digits, same panes.
    openPicker: () => openCapturePicker(),
    queryEligibleTargets: () => queryAnchoredTargets(),
    // Same adapter, same ledger, same ack/unknown-retry semantics, same
    // focusOnDeliver as Capture and Relay — Herald's payload is inline text.
    deliver: (payload, target) => deliverCapture(payload, target),
    // Slot 1's salvage: exactly the Ctrl+Alt+D outcome — clipboard write plus
    // the simulated Ctrl+V into whatever window is focused.
    pasteHere: (text) =>
      pasteTextImpl(text, {
        writeClipboard: (t) => clipboard.writeText(t),
        simulatePaste: () => simulatePasteKeystroke(),
      }),
    // Ctrl+Alt+V while Herald's picker is open (#101): the transcript into the
    // focused window — the same local ending as slot 1's "Paste here", reached
    // by the paste verb. The session mints the fresh payload id before this.
    pasteToForeground: (payload) => deliverToForeground(payload).then(() => undefined),
    mintId: () => randomUUID(),
    // The same ONE Last Target as Capture and Relay (issue #58, ADR 0004).
    again: {
      readLastTarget: () => lastTargetMemory.current(),
      hotkeyLabel: hotkeyLabelFor(HERALD_ACCELERATOR),
    },
  })
    .then((result) => console.log("[mistr-flow] herald session result:", result.kind))
    .catch((error) => console.error("[mistr-flow] herald session failed:", error))
    .finally(() => {
      verbLock.release("herald");
      captureRestingBounds = null;
    });
}

function createOverlayWindow(savedPosition: OverlayPosition | null = null): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  // 350, not the original 292: +20% for the 42" 4K (dogfood 2026-07-16) — long
  // status lines were ellipsizing in the 280px card. The renderer widens the
  // overlay/card/picker CSS to match (its TV-scale style block).
  const winWidth = 350;
  const winHeight = 178;
  const position = resolveOverlayPosition({ workArea: display.workArea, savedPosition });

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "public", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  void win.loadFile(path.join(__dirname, "..", "public", "overlay.html"));
  return win;
}

function setOverlayMouseEvents(ignore: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
}

function ensureOverlayStaysOnTop(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.moveTop();
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
}

let persistPositionTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistPosition(position: OverlayPosition): void {
  if (persistPositionTimer) clearTimeout(persistPositionTimer);
  persistPositionTimer = setTimeout(() => {
    persistPositionTimer = null;
    void writeOverlayPosition(position).catch((error) => {
      console.error("[mistr-flow] failed to persist overlay position:", error);
    });
  }, 400);
}

function moveOverlayBy(delta: { deltaX: number; deltaY: number }): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!Number.isFinite(delta.deltaX) || !Number.isFinite(delta.deltaY)) return;

  const [currentX, currentY] = overlayWindow.getPosition();
  const position = clampOverlayPosition(
    {
      x: currentX + delta.deltaX,
      y: currentY + delta.deltaY,
    },
    screen.getPrimaryDisplay().workArea,
  );

  overlayWindow.setPosition(position.x, position.y);
  ensureOverlayStaysOnTop();
  schedulePersistPosition(position);
}

function showContextMenu(): void {
  if (!overlayWindow) return;

  const menuModel = buildBarContextMenu();
  const menu = Menu.buildFromTemplate(
    menuModel.items.map((item) => ({
      label: item.label,
      click: () => {
        void runBarContextMenuAction(item.id, {
          quit: () => app.quit(),
          openConfigFile: (configPath) => openConfigFileWithDefaultHandler(configPath),
        });
      },
    })),
  );
  menu.popup({ window: overlayWindow });
}

async function ensureConfigExists(): Promise<boolean> {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) return true;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ openaiApiKey: "", muteSystemAudioWhileRecording: true }, null, 2),
    "utf8",
  );
  dialog.showErrorBox(
    "Mistr Flow needs an OpenAI API key",
    `Created ${configPath}. Add your OpenAI API key as "openaiApiKey" and restart Mistr Flow.`,
  );
  return false;
}

app.whenReady().then(async () => {
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  const ready = await ensureConfigExists();
  if (!ready) {
    app.quit();
    return;
  }

  try {
    const providerName = await readProvider();
    console.log("[mistr-flow] config: provider =", providerName);
    aiProvider = await resolveAiProvider(providerName);
    muteSystemAudioWhileRecording = await readMuteSystemAudioWhileRecording();
    const focusOnDeliver = await readFocusOnDeliver();
    console.log("[mistr-flow] config: focusOnDeliver =", focusOnDeliver);
    deliverCapture = buildDeliverCapture(focusOnDeliver);
    copySelectionFirst = await readCopySelectionFirst();
    console.log("[mistr-flow] config: copySelectionFirst =", copySelectionFirst);
    blockedChime = await readBlockedChime();
    console.log("[mistr-flow] config: blockedChime =", blockedChime);
    doneChime = await readDoneChime();
    console.log("[mistr-flow] config: doneChime =", doneChime);
    projectAnchors = await readProjectAnchors();
    console.log("[mistr-flow] config: projectAnchors =", projectAnchors.length);
    appTargets = await readAppTargets();
    console.log("[mistr-flow] config: appTargets =", appTargets.length);
  } catch (error) {
    dialog.showErrorBox("Mistr Flow config error", String(error));
    app.quit();
    return;
  }

  const vocabulary = await readVocabularyConfig().catch((error) => {
    console.warn("[mistr-flow] failed to read vocabulary config:", error);
    return null;
  });
  whisperVocabularyPrompt = buildWhisperVocabularyPrompt(vocabulary);
  polishVocabularyInstruction = buildPolishVocabularyInstruction(vocabulary);

  const savedOverlayPosition = await readOverlayPosition().catch((error) => {
    console.warn("[mistr-flow] failed to read saved overlay position:", error);
    return null;
  });

  overlayWindow = createOverlayWindow(savedOverlayPosition);
  ipcMain.on("show-context-menu", () => showContextMenu());
  // A plain click on the bar (issue #52) jumps to the longest-blocked agent —
  // the mouse-hand path to the same action as the Ctrl+Alt+J hotkey. The
  // renderer only fires this when the press stayed under the drag threshold; a
  // click with nothing blocked no-ops inside jumpToNextAttentionTarget. While a
  // picker is open the window is modal (issue #61, ADR 0005): the butler/header
  // is purely a window handle, so the jump is suppressed — routed through the
  // pure gate, restored the moment the picker closes (the handle's unsubscribe
  // nulls the click emit). The Ctrl+Alt+J hotkey is deliberately NOT gated:
  // keyboard behavior is byte-identical, the mouse is what the modal rule fixes.
  ipcMain.on("bar-clicked", () => {
    if (routeBarClick({ pickerOpen: activeRowClickEmit !== null }) === "jump") {
      jumpToNextAttentionTarget();
    }
  });
  ipcMain.on("set-overlay-mouse-events", (_event, { ignore }: { ignore: boolean }) => {
    setOverlayMouseEvents(ignore);
  });
  ipcMain.on("move-overlay-by", (_event, delta: { deltaX: number; deltaY: number }) => {
    moveOverlayBy(delta);
  });
  ipcMain.on("capture-crop", (_event, rect: CropRect) => {
    activeCropEmit?.(rect);
  });
  // A row click (issue #61, ADR 0005) — the row's identity, bound to the
  // render that built it; the active picker handle resolves it into the same
  // selection stream as the digits, or drops it if no picker is open.
  ipcMain.on("picker-row-clicked", (_event, click: PickerRowClick) => {
    activeRowClickEmit?.(click);
  });

  try {
    registerHotkey();
    registerCaptureHotkey();
    registerRelayHotkey();
    registerHeraldHotkey();
    registerJumpHotkey();
    registerPasteHotkey();
  } catch (error) {
    dialog.showErrorBox("Mistr Flow hotkey error", String(error));
  }

  startFleetPolling();
  startCaptureSweeping();
});

app.on("window-all-closed", () => {
  // Mistr Flow has no tray icon by design — the overlay bar is the only UI
  // surface, and quitting happens via its right-click context menu.
});

app.on("before-quit", (event) => {
  if (!activeSession || quitAfterSessionCleanup) return;

  event.preventDefault();
  quitAfterSessionCleanup = true;
  endSession("escape");
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (fleetPollTimer) {
    clearInterval(fleetPollTimer);
    fleetPollTimer = null;
  }
  if (captureSweepTimer) {
    clearInterval(captureSweepTimer);
    captureSweepTimer = null;
  }
});
