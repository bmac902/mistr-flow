import {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  globalShortcut,
  ipcMain,
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
  readOpenAiApiKey,
  readOverlayPosition,
  writeOverlayPosition,
} from "./config";
import { createDictationCancelledError, runDictationSession } from "./dictation";
import { polishTranscript, transcribeAudio } from "./openai";
import { pasteText as pasteTextImpl } from "./paste";
import { buildOverlaySnapshot } from "./overlay";
import {
  clampOverlayPosition,
  resolveOverlayPosition,
  type OverlayPosition,
} from "./overlayPosition";

let overlayWindow: BrowserWindow | null = null;
let apiKey = "";

interface ActiveSession {
  resolveAudio(buffer: Buffer): void;
  rejectAudio(error: Error): void;
}

let activeSession: ActiveSession | null = null;

function sendToRenderer(channel: string, payload?: unknown): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, payload);
  }
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

  activeSession = { resolveAudio, rejectAudio };
  globalShortcut.register("Escape", () => {
    if (activeSession) endSession("escape");
  });
  sendToRenderer("start-recording");

  void runDictationSession({
    showOverlay: (snapshot) => sendToRenderer("overlay-state", snapshot),
    playBeep: () => beep(),
    recordAudio: () => audioPromise,
    transcribe: (buffer) => transcribeAudio(buffer, { apiKey }),
    polish: (rawTranscript) => polishTranscript(rawTranscript, { apiKey }),
    pasteText: (text) =>
      pasteTextImpl(text, {
        writeClipboard: (t) => clipboard.writeText(t),
        simulatePaste: () => simulatePasteKeystroke(),
      }),
  })
    .then((result) => console.log("[mistr-flow] session result:", result.kind))
    .catch((error) => console.error("[mistr-flow] dictation session failed:", error))
    .finally(() => scheduleReturnToIdle());
}

function scheduleReturnToIdle(): void {
  setTimeout(() => {
    if (!activeSession) sendToRenderer("overlay-state", buildOverlaySnapshot("idle"));
  }, 5000);
}

function endSession(reason: "release" | "escape"): void {
  if (!activeSession) return;
  const { resolveAudio, rejectAudio } = activeSession;
  activeSession = null;
  globalShortcut.unregister("Escape");

  if (reason === "escape") {
    sendToRenderer("cancel-recording");
    rejectAudio(createDictationCancelledError("escape"));
    return;
  }

  bloop();
  requestStopRecording().then(resolveAudio).catch(rejectAudio);
}

const TOGGLE_ACCELERATOR = "Control+Alt+D";

function registerHotkey(): void {
  const registered = globalShortcut.register(TOGGLE_ACCELERATOR, () => {
    if (activeSession) {
      endSession("release");
    } else {
      startSession();
    }
  });

  if (!registered) {
    throw new Error(
      `Failed to register global hotkey "${TOGGLE_ACCELERATOR}". It may already be in use by another app.`,
    );
  }
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
  void writeOverlayPosition(position).catch((error) => {
    console.error("[mistr-flow] failed to persist overlay position:", error);
  });
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
  fs.writeFileSync(configPath, JSON.stringify({ openaiApiKey: "" }, null, 2), "utf8");
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
  } catch (error) {
    dialog.showErrorBox("Mistr Flow config error", String(error));
    app.quit();
    return;
  }

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
  } catch (error) {
    dialog.showErrorBox("Mistr Flow hotkey error", String(error));
  }
});

app.on("window-all-closed", () => {
  // Mistr Flow has no tray icon by design — the overlay bar is the only UI
  // surface, and quitting happens via its right-click context menu.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
