const overlayEl = document.getElementById("mistr-flow-overlay");
const cardEl = document.getElementById("mistr-flow-card");
const mascotEl = document.getElementById("mascot");
const statusCopyEl = document.getElementById("status-copy");
const toastEl = document.getElementById("toast");

let mediaRecorder = null;
let chunks = [];
let micStream = null;
let overlayIgnoringMouse = true;
let dragPointerId = null;
let lastDragPoint = null;

function setOverlayMouseEvents(ignore) {
  if (overlayIgnoringMouse === ignore) return;
  overlayIgnoringMouse = ignore;
  window.mistrFlow.setOverlayMouseEvents({ ignore });
}

function updateMousePassThrough(event) {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const overDragTarget = Boolean(
    target && (cardEl.contains(target) || mascotEl.contains(target)),
  );
  setOverlayMouseEvents(!overDragTarget);
}

function startOverlayDrag(event) {
  if (event.button !== 0) return;

  event.preventDefault();
  dragPointerId = event.pointerId;
  lastDragPoint = { x: event.screenX, y: event.screenY };
  setOverlayMouseEvents(false);
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveOverlayDrag(event) {
  if (dragPointerId !== event.pointerId || !lastDragPoint) return;

  const deltaX = event.screenX - lastDragPoint.x;
  const deltaY = event.screenY - lastDragPoint.y;
  if (deltaX !== 0 || deltaY !== 0) {
    window.mistrFlow.moveOverlayBy({ deltaX, deltaY });
    lastDragPoint = { x: event.screenX, y: event.screenY };
  }
}

function endOverlayDrag(event) {
  if (dragPointerId !== event.pointerId) return;

  event.currentTarget.releasePointerCapture?.(event.pointerId);
  dragPointerId = null;
  lastDragPoint = null;
  updateMousePassThrough(event);
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
  const previousPhase = overlayEl.dataset.phase || "idle";
  overlayEl.dataset.phase = snapshot.phase;
  overlayEl.classList.remove(`mf-state-${previousPhase}`);
  overlayEl.classList.add(`mf-state-${snapshot.phase}`);
  mascotEl.classList.remove(`mf-state-${previousPhase}`);
  mascotEl.classList.add(`mf-state-${snapshot.phase}`);
  statusCopyEl.textContent = snapshot.statusCopy;
  toastEl.textContent = snapshot.toastCopy || "";
});

window.addEventListener("mousemove", updateMousePassThrough);
window.addEventListener("mouseleave", () => setOverlayMouseEvents(true));
window.mistrFlow.setOverlayMouseEvents({ ignore: true });

for (const dragTarget of [cardEl, mascotEl]) {
  dragTarget.addEventListener("pointerdown", startOverlayDrag);
  dragTarget.addEventListener("pointermove", moveOverlayDrag);
  dragTarget.addEventListener("pointerup", endOverlayDrag);
  dragTarget.addEventListener("pointercancel", endOverlayDrag);
}

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.mistrFlow.requestContextMenu();
});
