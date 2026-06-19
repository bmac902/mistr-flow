const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mistrFlow", {
  onStartRecording: (callback) => ipcRenderer.on("start-recording", () => callback()),
  onStopRecording: (callback) => ipcRenderer.on("stop-recording", () => callback()),
  onCancelRecording: (callback) => ipcRenderer.on("cancel-recording", () => callback()),
  onOverlayState: (callback) =>
    ipcRenderer.on("overlay-state", (_event, snapshot) => callback(snapshot)),
  sendRecordingStopped: (arrayBuffer) => ipcRenderer.send("recording-stopped", arrayBuffer),
  setOverlayMouseEvents: ({ ignore }) => ipcRenderer.send("set-overlay-mouse-events", { ignore }),
  requestContextMenu: () => ipcRenderer.send("show-context-menu"),
});
