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
} from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  buildBarContextMenu,
  openConfigFileWithDefaultHandler,
  runBarContextMenuAction,
} from "./barControls";
import {
  getConfigPath,
  readMuteSystemAudioWhileRecording,
  readOpenAiApiKey,
  readOverlayPosition,
  readVocabularyConfig,
  writeOverlayPosition,
} from "./config";
import { createDictationCancelledError, runDictationSession } from "./dictation";
import { polishTranscript, transcribeAudio } from "./openai";
import { buildPolishVocabularyInstruction, buildWhisperVocabularyPrompt } from "./vocabulary";
import { pasteText as pasteTextImpl } from "./paste";
import { buildOverlaySnapshot, buildRefusedOverlaySnapshot, type OverlaySnapshot } from "./overlay";
import { createActiveVerbLock } from "./activeVerbLock";
import {
  clampOverlayPosition,
  resolveOverlayPosition,
  type OverlayPosition,
} from "./overlayPosition";
import { createSessionIdleReturn, type SessionIdleReturn } from "./sessionIdleReturn";
import { muteSystemAudio, type SystemAudioMuteHandle } from "./systemAudio";
import { captureActiveWindow as captureActiveWindowImpl, type CaptureArtifact } from "./capture";
import {
  createCaptureGrabFailedError,
  runCaptureSession,
  type CapturePickerHandle,
} from "./captureSession";
import { createCapturePickerHandle } from "./capturePickerHandle";
import { createHerdrDeliveryAdapter } from "./deliver";
import { queryHerdr } from "./herdr";
import {
  capturePickerWindowHeight,
  resolveGrownWindowBounds,
  type WindowBounds,
} from "./captureWindowBounds";
import { nativeWindowHandleToHwnd } from "./nativeWindowHandle";

let overlayWindow: BrowserWindow | null = null;
let apiKey = "";
let muteSystemAudioWhileRecording = true;
let whisperVocabularyPrompt: string | null = null;
let polishVocabularyInstruction: string | null = null;

interface ActiveSession {
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
]);

function sendToRenderer(channel: string, payload?: unknown): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
}

function applyCaptureWindowBounds(snapshot: OverlaySnapshot): void {
  if (!overlayWindow || overlayWindow.isDestroyed() || !captureRestingBounds) return;

  if (snapshot.phase === "capture-picker") {
    const bounds = resolveGrownWindowBounds({
      restingBounds: captureRestingBounds,
      grownHeight: capturePickerWindowHeight(snapshot.captureTargets?.length ?? 0),
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

function startSession(): void {
  if (activeSession) return;

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
  session = { resolveAudio, rejectAudio, systemAudioMutePromise, cleanupPromise: null, idleReturn };
  activeSession = session;
  globalShortcut.register("Escape", () => {
    if (activeSession) endSession("escape");
  });
  sendToRenderer("start-recording");

  void runDictationSession({
    showOverlay: (snapshot) => sendToRenderer("overlay-state", snapshot),
    playBeep: () => beep(),
    recordAudio: () => audioPromise,
    transcribe: (buffer) => transcribeAudio(buffer, { apiKey, vocabularyPrompt: whisperVocabularyPrompt }),
    polish: (rawTranscript) => polishTranscript(rawTranscript, { apiKey, vocabularyInstruction: polishVocabularyInstruction }),
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
    verbLock.release("dictation");
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
    if (activeSession) {
      endSession("release");
      return;
    }

    if (!verbLock.tryStart("dictation")) {
      sendToRenderer("overlay-state", buildRefusedOverlaySnapshot());
      return;
    }

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
    if (!verbLock.tryStart("capture")) {
      sendToRenderer("overlay-state", buildRefusedOverlaySnapshot());
      return;
    }

    startCapture();
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${CAPTURE_ACCELERATOR}". It may already be in use by another app.`,
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

// One adapter instance for the app's lifetime: its delivery ledger must
// persist across a session's unknown → retry digit presses (#32).
const deliverCapture = createHerdrDeliveryAdapter();

function openCapturePicker(): CapturePickerHandle {
  return createCapturePickerHandle({
    shortcuts: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
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
    queryEligibleTargets: () => queryHerdr({}),
    copyToClipboard: (artifact) => copyCaptureToClipboard(artifact),
    deliver: (capture, target) => deliverCapture(capture, target),
  })
    .then((result) => console.log("[mistr-flow] capture session result:", result.kind))
    .catch((error) => console.error("[mistr-flow] capture session failed:", error))
    .finally(() => {
      verbLock.release("capture");
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
    apiKey = await readOpenAiApiKey();
    muteSystemAudioWhileRecording = await readMuteSystemAudioWhileRecording();
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
  ipcMain.on("set-overlay-mouse-events", (_event, { ignore }: { ignore: boolean }) => {
    setOverlayMouseEvents(ignore);
  });
  ipcMain.on("move-overlay-by", (_event, delta: { deltaX: number; deltaY: number }) => {
    moveOverlayBy(delta);
  });

  try {
    registerHotkey();
    registerCaptureHotkey();
  } catch (error) {
    dialog.showErrorBox("Mistr Flow hotkey error", String(error));
  }
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
});
