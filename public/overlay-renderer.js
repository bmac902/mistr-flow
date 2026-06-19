const overlayEl = document.getElementById("mistr-flow-overlay");
const cardEl = document.getElementById("mistr-flow-card");
const statusCopyEl = document.getElementById("status-copy");
const toastEl = document.getElementById("toast");

let mediaRecorder = null;
let chunks = [];
let micStream = null;
let overlayIgnoringMouse = true;

function setOverlayMouseEvents(ignore) {
  if (overlayIgnoringMouse === ignore) return;
  overlayIgnoringMouse = ignore;
  window.mistrFlow.setOverlayMouseEvents({ ignore });
}

function updateMousePassThrough(event) {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const overCard = Boolean(target && cardEl.contains(target));
  setOverlayMouseEvents(!overCard);
}

async function startRecording() {
  chunks = [];
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  mediaRecorder.start();
}

function stopAndSendRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    window.mistrFlow.sendRecordingStopped(arrayBuffer);
    micStream.getTracks().forEach((track) => track.stop());
    mediaRecorder = null;
  };
  mediaRecorder.stop();
}

function cancelRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.onstop = () => {
    micStream.getTracks().forEach((track) => track.stop());
    mediaRecorder = null;
  };
  mediaRecorder.stop();
}

window.mistrFlow.onStartRecording(() => {
  startRecording().catch((error) => console.error("[mistr-flow] mic capture failed:", error));
});
window.mistrFlow.onStopRecording(() => stopAndSendRecording());
window.mistrFlow.onCancelRecording(() => cancelRecording());

window.mistrFlow.onOverlayState((snapshot) => {
  overlayEl.dataset.phase = snapshot.phase;
  statusCopyEl.textContent = snapshot.statusCopy;
  toastEl.textContent = snapshot.toastCopy || "";
});

window.addEventListener("mousemove", updateMousePassThrough);
window.addEventListener("mouseleave", () => setOverlayMouseEvents(true));
window.mistrFlow.setOverlayMouseEvents({ ignore: true });

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.mistrFlow.requestContextMenu();
});
