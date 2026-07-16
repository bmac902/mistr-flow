const overlayEl = document.getElementById("mistr-flow-overlay");
const cardEl = document.getElementById("mistr-flow-card");
const mascotEl = document.getElementById("mascot");
const statusCopyEl = document.getElementById("status-copy");
const toastEl = document.getElementById("toast");
const pickerEntriesEl = document.getElementById("capture-picker-entries");
const previewEl = document.getElementById("capture-preview");
const previewImageEl = document.getElementById("capture-preview-image");
const previewTitleEl = document.getElementById("capture-preview-title");
const cropRectEl = document.getElementById("capture-crop-rect");

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
    target &&
      (cardEl.contains(target) ||
        mascotEl.contains(target) ||
        // The preview is only interactive while it's showing something to crop.
        (previewEl.classList.contains("has-preview") && previewEl.contains(target))),
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

// object-fit: contain letterboxes the image inside its element, so the drawn
// pixels are a sub-rect of the element box. Crop coords must be relative to
// the image content, not the box, or every drag is offset.
function renderedImageRect(img) {
  const box = img.getBoundingClientRect();
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (!naturalW || !naturalH) return box;

  const scale = Math.min(box.width / naturalW, box.height / naturalH);
  const width = naturalW * scale;
  const height = naturalH * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

function toNormalizedPoint(event, rect) {
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

let cropPointerId = null;
let cropStart = null;

function updateCropOverlay(rect, current) {
  if (!cropStart || !rect) return;
  const left = Math.min(cropStart.clientX, current.clientX);
  const top = Math.min(cropStart.clientY, current.clientY);
  const width = Math.abs(current.clientX - cropStart.clientX);
  const height = Math.abs(current.clientY - cropStart.clientY);
  const parent = previewEl.getBoundingClientRect();

  cropRectEl.style.display = "block";
  cropRectEl.style.left = `${left - parent.left}px`;
  cropRectEl.style.top = `${top - parent.top}px`;
  cropRectEl.style.width = `${width}px`;
  cropRectEl.style.height = `${height}px`;
}

function hideCropOverlay() {
  cropRectEl.style.display = "none";
}

function startCropDrag(event) {
  if (event.button !== 0 || !previewEl.classList.contains("has-preview")) return;

  event.preventDefault();
  event.stopPropagation();
  cropPointerId = event.pointerId;
  const rect = renderedImageRect(previewImageEl);
  cropStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    norm: toNormalizedPoint(event, rect),
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveCropDrag(event) {
  if (cropPointerId !== event.pointerId || !cropStart) return;
  event.preventDefault();
  updateCropOverlay(renderedImageRect(previewImageEl), event);
}

function endCropDrag(event) {
  if (cropPointerId !== event.pointerId || !cropStart) return;

  event.preventDefault();
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  const end = toNormalizedPoint(event, renderedImageRect(previewImageEl));
  const start = cropStart.norm;
  cropPointerId = null;
  cropStart = null;
  hideCropOverlay();

  // Main applies the same MIN_CROP_FRACTION guard; this is just to avoid
  // shipping an obvious stray click across IPC.
  if (Math.abs(end.x - start.x) < 0.02 || Math.abs(end.y - start.y) < 0.02) return;

  window.mistrFlow.sendCaptureCrop({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });
}

function cancelCropDrag(event) {
  if (cropPointerId !== event.pointerId) return;
  cropPointerId = null;
  cropStart = null;
  hideCropOverlay();
}

function buildPickerEntryEl(digit, label) {
  const entry = document.createElement("div");
  entry.className = "capture-picker-entry";
  entry.dataset.digit = String(digit);

  const digitEl = document.createElement("span");
  digitEl.className = "capture-picker-entry-digit";
  digitEl.textContent = String(digit);

  const labelEl = document.createElement("span");
  labelEl.className = "capture-picker-entry-label";
  labelEl.textContent = label;

  entry.appendChild(digitEl);
  entry.appendChild(labelEl);
  return entry;
}

function renderCapturePickerEntries(snapshot) {
  pickerEntriesEl.textContent = "";
  if (snapshot.phase !== "capture-picker") return;

  pickerEntriesEl.appendChild(buildPickerEntryEl(1, "Clipboard"));
  for (const [index, target] of (snapshot.captureTargets || []).entries()) {
    pickerEntriesEl.appendChild(buildPickerEntryEl(index + 2, target.label));
  }
}

// Preview is picker-only and best-effort: no preview on the snapshot (or a
// non-picker phase) simply hides the block. Clearing the src releases the
// data URL rather than holding a stale capture in the DOM.
function renderCapturePreview(snapshot) {
  const preview =
    snapshot.phase === "capture-picker" ? snapshot.capturePreview : undefined;

  hideCropOverlay();

  if (!preview) {
    previewEl.classList.remove("has-preview");
    previewImageEl.removeAttribute("src");
    previewTitleEl.textContent = "";
    return;
  }

  previewImageEl.src = preview.dataUrl;
  previewTitleEl.textContent = preview.windowTitle;
  previewEl.classList.add("has-preview");
}

window.mistrFlow.onOverlayState((snapshot) => {
  const previousPhase = overlayEl.dataset.phase || "idle";
  overlayEl.dataset.phase = snapshot.phase;
  overlayEl.classList.remove(`mf-state-${previousPhase}`);
  overlayEl.classList.add(`mf-state-${snapshot.phase}`);
  mascotEl.classList.remove(`mf-state-${previousPhase}`);
  mascotEl.classList.add(`mf-state-${snapshot.phase}`);
  mascotEl.classList.toggle("mf-picker-summoning", Boolean(snapshot.pickerSummoning));
  statusCopyEl.textContent = snapshot.statusCopy;
  toastEl.textContent = snapshot.toastCopy || "";
  renderCapturePreview(snapshot);
  renderCapturePickerEntries(snapshot);
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

// The preview drags to crop rather than to move the overlay.
previewEl.addEventListener("pointerdown", startCropDrag);
previewEl.addEventListener("pointermove", moveCropDrag);
previewEl.addEventListener("pointerup", endCropDrag);
previewEl.addEventListener("pointercancel", cancelCropDrag);
previewEl.addEventListener("dragstart", (event) => event.preventDefault());

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.mistrFlow.requestContextMenu();
});
