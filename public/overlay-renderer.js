const barEl = document.getElementById("bar");
const toastEl = document.getElementById("toast");

let mediaRecorder = null;
let chunks = [];
let micStream = null;

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
  barEl.textContent = `🎩 ${snapshot.mascotCopy}`;
  barEl.className = ["error", "done", "cancelled"].includes(snapshot.phase) ? snapshot.phase : "";
  toastEl.textContent = snapshot.toastCopy || "";
});

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.mistrFlow.requestContextMenu();
});
