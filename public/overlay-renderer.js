const overlayEl = document.getElementById("mistr-flow-overlay");
const cardEl = document.getElementById("mistr-flow-card");
const mascotEl = document.getElementById("mascot");
const statusCopyEl = document.getElementById("status-copy");
const toastEl = document.getElementById("toast");
const pickerEntriesEl = document.getElementById("capture-picker-entries");
const previewEl = document.getElementById("capture-preview");
const previewImageEl = document.getElementById("capture-preview-image");
const previewTitleEl = document.getElementById("capture-preview-title");
const previewTextEl = document.getElementById("capture-preview-text");
const cropRectEl = document.getElementById("capture-crop-rect");

let mediaRecorder = null;
let chunks = [];
let micStream = null;
let overlayIgnoringMouse = true;
let dragPointerId = null;
let dragGesture = null;

// The click-vs-drag threshold (issue #52). A press that travels more than this
// many pixels repositions the overlay; a press that stays under it is a plain
// click that jumps to the longest-blocked agent. Mirrors DRAG_THRESHOLD_PX in
// src/clickDragGesture.ts, whose pure logic is unit-tested there.
const DRAG_THRESHOLD_PX = 4;

// A standalone port of createClickDragGesture (src/clickDragGesture.ts) — the
// renderer runs as a plain script with no module loader, so the tested logic is
// mirrored here. Keep the two in step.
function createClickDragGesture(originX, originY, threshold = DRAG_THRESHOLD_PX) {
  let isDrag = false;
  let trackedX = originX;
  let trackedY = originY;
  return {
    move(x, y) {
      if (!isDrag) {
        if (Math.hypot(x - originX, y - originY) <= threshold) {
          return { deltaX: 0, deltaY: 0 };
        }
        isDrag = true;
        trackedX = x;
        trackedY = y;
        return { deltaX: x - originX, deltaY: y - originY };
      }
      const delta = { deltaX: x - trackedX, deltaY: y - trackedY };
      trackedX = x;
      trackedY = y;
      return delta;
    },
    end() {
      return isDrag ? "drag" : "click";
    },
  };
}

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
  dragGesture = createClickDragGesture(event.screenX, event.screenY);
  setOverlayMouseEvents(false);
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveOverlayDrag(event) {
  if (dragPointerId !== event.pointerId || !dragGesture) return;

  const { deltaX, deltaY } = dragGesture.move(event.screenX, event.screenY);
  if (deltaX !== 0 || deltaY !== 0) {
    window.mistrFlow.moveOverlayBy({ deltaX, deltaY });
  }
}

function endOverlayDrag(event) {
  if (dragPointerId !== event.pointerId) return;

  event.currentTarget.releasePointerCapture?.(event.pointerId);
  // A press that never crossed the threshold is a plain click, not a
  // reposition: jump to the longest-blocked agent (a truthful no-op in main if
  // nothing is blocked). pointercancel resolves to a drag, so it never jumps.
  const gesture = dragGesture;
  dragPointerId = null;
  dragGesture = null;
  if (event.type === "pointerup" && gesture && gesture.end() === "click") {
    window.mistrFlow.requestJumpToBlocked();
  }
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

// The framing beat (issue #41): while a crop is being dragged, the mascot
// raises a monocle to appraise it — renderer-local, since the session phase is
// still capture-picker underneath. Cleared on drag end; the next real snapshot
// re-render is authoritative regardless.
function setFraming(active) {
  mascotEl.classList.toggle("mf-state-capture-framing", active);
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
  setFraming(true);
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
  setFraming(false);

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
  setFraming(false);
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

  // Slot 1 is the pinned Clipboard destination for Capture; for Relay
  // (clipboardSlot === false) it is skipped — the clipboard is the source —
  // but panes still occupy digits 2–9 either way. Herald keeps the slot and
  // relabels it "Paste here" via slotOneLabel (issue #55).
  if (snapshot.clipboardSlot !== false) {
    pickerEntriesEl.appendChild(
      buildPickerEntryEl(1, snapshot.slotOneLabel || "Clipboard"),
    );
  }
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
    previewEl.classList.remove("is-text");
    return;
  }

  if (preview.kind === "text") {
    // Relayed text: show the first copied lines plus the one-line summary,
    // rather than a thumbnail. Same panel, different payload (issue #39).
    previewImageEl.removeAttribute("src");
    previewTitleEl.textContent = preview.summary;
    previewEl.classList.add("has-preview", "is-text");
    previewTextEl.textContent = preview.firstLines;
    return;
  }

  previewEl.classList.remove("is-text");
  previewTextEl.textContent = "";
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
  // Relay delivering shows a payload-specific prop (note/ledger/portrait); the
  // ledger also rides the picker as a spill modifier (issue #41).
  for (const kind of ["note", "ledger", "portrait"]) {
    mascotEl.classList.toggle(`mf-payload-${kind}`, snapshot.relayPayloadKind === kind);
  }
  mascotEl.classList.toggle("mf-ledger-spill", Boolean(snapshot.ledgerSpill));
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
