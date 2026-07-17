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
  readFocusOnDeliver,
  readPersistentBlockDing,
  readMuteSystemAudioWhileRecording,
  readOverlayPosition,
  readProvider,
  readVocabularyConfig,
  writeOverlayPosition,
} from "./config";
import { resolveAiProvider, type AiProvider } from "./aiProvider";
import { createDictationCancelledError, runDictationSession } from "./dictation";
import { buildPolishVocabularyInstruction, buildWhisperVocabularyPrompt } from "./vocabulary";
import { pasteText as pasteTextImpl } from "./paste";
import {
  buildFleetPostureOverlaySnapshot,
  buildOverlaySnapshot,
  buildRefusedOverlaySnapshot,
  type OverlaySnapshot,
} from "./overlay";
import { createFleetState, type FleetPosture } from "./fleetState";
import { attentionCycle, createBlockedJumpCursor } from "./blockedJumpCursor";
import {
  createHerdrForegroundCheck,
  playDoneChime,
  shouldChimeDone,
  type IsHerdrForeground,
} from "./doneChime";
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
  type CaptureArtifact,
} from "./capture";
import { readClipboardSource, type ClipboardSourcePort } from "./clipboardSource";
import { runRelaySession } from "./relaySession";
import { runHeraldSession } from "./heraldSession";
import {
  createCaptureGrabFailedError,
  runCaptureSession,
  type CapturePickerHandle,
} from "./captureSession";
import {
  createCapturePickerHandle,
  type AgainSource,
  type CropSource,
  type PickerRowClick,
  type RowClickSource,
} from "./capturePickerHandle";
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
import { captureArtifactToPayload, createHerdrDeliveryAdapter } from "./deliver";
import { createLastTargetMemory, withLastTargetRecording } from "./lastTarget";
import { queryHerdr, queryWatchedSet, readHerdrSocketPath } from "./herdr";
import {
  capturePickerWindowHeight,
  resolveGrownWindowBounds,
  type WindowBounds,
} from "./captureWindowBounds";
import { nativeWindowHandleToHwnd } from "./nativeWindowHandle";

let overlayWindow: BrowserWindow | null = null;
let aiProvider: AiProvider | null = null;
let muteSystemAudioWhileRecording = true;
let copySelectionFirst = false;
// PRD #44 / #51: the persistent-block ding is on by default; config can silence
// the sound while keeping the visual fleet awareness. Read once at startup.
let persistentBlockDing = true;
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
  sendToRenderer("overlay-state", buildFleetPostureOverlaySnapshot(posture.tier));
}

async function pollFleetOnce(): Promise<void> {
  const result = await queryWatchedSet({});
  const posture =
    result.kind === "watched"
      ? fleetState.observe({ kind: "panes", agents: result.agents }, Date.now())
      : fleetState.observe({ kind: "unavailable" }, Date.now());
  renderFleetPosture(posture);
  maybeDingPersistentBlock(posture);
  await maybeChimeDone(posture);
}

/**
 * The single active cue of the whole feature (#51): one quiet ding when an agent
 * has been continuously blocked past the persistent-block duration. fleetState
 * fires the one-shot signal; here we decide whether to actually sound it —
 * silenced by config, and suppressed while a verb is active (the ding only
 * matters when you're away from the work, never mid-dictation). One ding per
 * poll regardless of how many crossed, since it's a nudge, not a count.
 */
function maybeDingPersistentBlock(posture: FleetPosture): void {
  if (posture.newlyPersistentBlockedTargets.length === 0) return;
  if (!persistentBlockDing) return;
  if (verbLock.activeVerb() !== null) return;
  beep();
}

// The done-awareness foreground seam (ADR 0006 §3): "is Herdr's host window the
// OS foreground window right now?" Created lazily so a missing socket at startup
// doesn't matter — identification re-reads the socket path per attempt.
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
 * The one soft chime of done-awareness (ADR 0006 §§2–3, #80): when a done episode
 * begins and Herdr's host window is not the OS foreground window at that poll,
 * sound a single gentle chime — distinct from and softer than the block ding.
 * The foreground gate is evaluated exactly once, at the transition poll: Herdr
 * being foreground *consumes* the chime for that episode (fleetState's one-shot is
 * already spent), never deferring it to a later alt-tab. Config- and verb-gated
 * exactly like the ding; suppression silences the sound only, never the state.
 */
async function maybeChimeDone(posture: FleetPosture): Promise<void> {
  if (posture.newlyDoneTargets.length === 0) return;
  const herdrForeground = await isHerdrForeground();
  if (
    shouldChimeDone({
      newlyDoneTargets: posture.newlyDoneTargets,
      chimeEnabled: doneChime,
      verbActive: verbLock.activeVerb() !== null,
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
function jumpToLongestBlocked(): void {
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

    if (!verbLock.tryStart("dictation")) {
      refuseVerb();
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

const CAPTURE_ACCELERATOR = "Control+Shift+`";

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

    if (!verbLock.tryStart("capture")) {
      refuseVerb();
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

    if (!verbLock.tryStart("relay")) {
      refuseVerb();
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

    if (!verbLock.tryStart("herald")) {
      refuseVerb();
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
    jumpToLongestBlocked();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${JUMP_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
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

// One adapter instance for the app's lifetime: its delivery ledger must
// persist across a session's unknown → retry digit presses (#32). Rebuilt
// once at startup once config (focusOnDeliver) is known — see whenReady.
let deliverCapture = withLastTargetRecording(
  createHerdrDeliveryAdapter(),
  lastTargetMemory,
);

function openCapturePicker(): CapturePickerHandle {
  return createCapturePickerHandle({
    shortcuts: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    cropSource: captureCropSource,
    againSource: pickerAgainSource,
    clickSource: pickerRowClickSource,
  });
}

function startCapture(): void {
  captureRestingBounds = overlayWindow && !overlayWindow.isDestroyed()
    ? overlayWindow.getBounds()
    : null;

  void runCaptureSession({
    showOverlay: (snapshot) => showCaptureOverlay(snapshot),
    captureActiveWindow: () => grabActiveWindow(),
    openPicker: () => openCapturePicker(),
    renderThumbnail: (artifact) => renderCaptureThumbnail(artifact),
    cropCapture: (artifact, rect) => cropCaptureArtifact(artifact, rect),
    queryEligibleTargets: () => queryHerdr({}),
    copyToClipboard: (artifact) => copyCaptureToClipboard(artifact),
    deliver: (capture, target) =>
      deliverCapture(captureArtifactToPayload(capture), target),
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

// Relay reads/PNG-spills into the same temp dir captures use, so the existing
// TTL sweep reclaims relay spill/image files too (CONTEXT.md).
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
        const paths = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        resolve(paths.length > 0 ? paths : null);
      },
    );
  });
}

function relayClipboardPort(): ClipboardSourcePort {
  return {
    readText: () => clipboard.readText(),
    readImage: () => {
      const image = clipboard.readImage();
      return { isEmpty: () => image.isEmpty(), toPNG: () => image.toPNG() };
    },
    readFilePath: () => readClipboardFilePath(),
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
    queryEligibleTargets: () => queryHerdr({}),
    // Same adapter, same ledger, same ack/unknown-retry semantics, same
    // focusOnDeliver as Capture — Relay's payload just isn't always a PNG.
    deliver: (payload, target) => deliverCapture(payload, target),
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
    queryEligibleTargets: () => queryHerdr({}),
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
  const winWidth = 292;
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
    deliverCapture = withLastTargetRecording(
      createHerdrDeliveryAdapter({ focusOnDeliver }),
      lastTargetMemory,
    );
    copySelectionFirst = await readCopySelectionFirst();
    console.log("[mistr-flow] config: copySelectionFirst =", copySelectionFirst);
    persistentBlockDing = await readPersistentBlockDing();
    console.log("[mistr-flow] config: persistentBlockDing =", persistentBlockDing);
    doneChime = await readDoneChime();
    console.log("[mistr-flow] config: doneChime =", doneChime);
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
  // click with nothing blocked no-ops inside jumpToLongestBlocked. While a
  // picker is open the window is modal (issue #61, ADR 0005): the butler/header
  // is purely a window handle, so the jump is suppressed — routed through the
  // pure gate, restored the moment the picker closes (the handle's unsubscribe
  // nulls the click emit). The Ctrl+Alt+J hotkey is deliberately NOT gated:
  // keyboard behavior is byte-identical, the mouse is what the modal rule fixes.
  ipcMain.on("bar-clicked", () => {
    if (routeBarClick({ pickerOpen: activeRowClickEmit !== null }) === "jump") {
      jumpToLongestBlocked();
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
  } catch (error) {
    dialog.showErrorBox("Mistr Flow hotkey error", String(error));
  }

  startFleetPolling();
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
});
