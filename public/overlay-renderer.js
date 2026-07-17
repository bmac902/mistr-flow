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

// Button affordances for the picker rows (issue #61, ADR 0005): while a
// picker is open the rows ARE buttons — pointer cursor, hover, pressed — and
// the entries column becomes pointer-interactive (the design asset ships it
// pointer-events: none). Renderer-owned <style>, same discipline as the
// again-row's unmark styling: overlay.html is a Claude Design asset and
// carries no knowledge of clickability. Everything is scoped to
// .mf-state-capture-picker, so the affordances vanish with the picker and
// pointer behavior returns to the resting bar's on close. The pressed state
// avoids transform — the entry-in animation's fill would override it.
const pickerRowStyle = document.createElement("style");
pickerRowStyle.textContent = `
  .mf-state-capture-picker #capture-picker-entries { pointer-events: auto; }
  .mf-state-capture-picker .capture-picker-entry { cursor: pointer; }
  .mf-state-capture-picker .capture-picker-entry:hover {
    border-color: var(--brass);
    filter: brightness(1.04);
  }
  .mf-state-capture-picker .capture-picker-entry:active {
    filter: brightness(0.93);
  }
`;
document.head.appendChild(pickerRowStyle);

// Done-awareness ambient badge (ADR 0006 §5, PRD #77 / #81): a small count of
// current *done* panes — "what have you finished?" — sitting on the idle bar
// beside the butler's "who needs you?" posture. Renderer-owned entirely, same
// discipline as the picker-row affordances above: overlay.html is a Claude
// Design asset and carries no knowledge of this chip. The look is a deliberate
// placeholder — a later design round-trip blesses the real thing. The chip only
// mounts on the resting bar and only when the count is ≥ 1 (see below); zero or
// a verb state renders nothing.
const doneBadgeStyle = document.createElement("style");
doneBadgeStyle.textContent = `
  #mf-done-badge {
    display: none;
    position: absolute;
    top: 6px;
    right: 8px;
    min-width: 16px;
    padding: 2px 7px;
    background: #d4af5e;
    border: none;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    line-height: 15px;
    text-align: center;
    color: #16100a;
    box-shadow: 0 0 6px rgba(212, 175, 94, 0.45);
    pointer-events: none;
  }
  #mf-done-badge.mf-has-done { display: block; }
`;
document.head.appendChild(doneBadgeStyle);

const doneBadgeEl = document.createElement("div");
doneBadgeEl.id = "mf-done-badge";
cardEl.appendChild(doneBadgeEl);

// TV-scale nudge (dogfood 2026-07-16): on the 42" 4K the butler reads tiny, so
// the mascot ensemble — butler + mic, the whole #mascot SVG — gets an 18% lift.
// Renderer-owned override, same discipline as the chip above: overlay.html is a
// Claude Design asset and stays byte-identical. The stage and its floor shadow
// keep their designed size ("the whole thing, not the stage"): the scale
// anchors at his feet (origin bottom-center), so he grows up and out, planted
// on the same mark, and the chained translateX preserves the asset's own
// centering.
const mascotScaleStyle = document.createElement("style");
mascotScaleStyle.textContent = `
  #mascot {
    transform: translateX(-50%) scale(1.25);
    transform-origin: 50% 100%;
  }
`;
document.head.appendChild(mascotScaleStyle);

// Reflect the current done count onto the chip. Idle-only falls out for free:
// only the fleet-posture snapshots carry doneCount, and those are the resting
// bar; verb snapshots omit it, so the chip clears the moment a verb takes over.
function renderDoneBadge(snapshot) {
  const count = Number(snapshot.doneCount) || 0;
  if (count >= 1) {
    doneBadgeEl.textContent = String(count);
    doneBadgeEl.classList.add("mf-has-done");
  } else {
    doneBadgeEl.textContent = "";
    doneBadgeEl.classList.remove("mf-has-done");
  }
}

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
  const overInteractive = Boolean(
    target &&
      (cardEl.contains(target) ||
        mascotEl.contains(target) ||
        // Picker rows are buttons while a picker is open (issue #61, ADR
        // 0005). The container is display:none outside the picker phase, so
        // elementFromPoint can never land here at rest — mouse passthrough
        // returns to today's behavior the moment the picker closes.
        pickerEntriesEl.contains(target) ||
        // The preview is only interactive while it's showing something to crop.
        (previewEl.classList.contains("has-preview") && previewEl.contains(target))),
  );
  setOverlayMouseEvents(!overInteractive);
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

// The "⟲ again" row (issue #58, ADR 0004): the fast path to the Last Target,
// keyed to the verb's own hotkey — the key cap shows the hotkey, never a
// digit. It rides the list from the picker's FIRST frame (rendered from
// memory while the pane query is still out), and when the query lands it
// either refreshes or visibly unmarks — dimmed and struck through with its
// reason on the row — never a silent disappearance. Same entry classes as
// the digit slots, so it inherits the design language; the unmark styling is
// inline because overlay.html is a Claude Design asset the renderer must
// never require edits to.
function buildAgainRowEl(againRow) {
  const entry = buildPickerEntryEl(`⟲ ${againRow.hotkeyLabel}`, againRow.label);
  const keyEl = entry.querySelector(".capture-picker-entry-digit");
  // The hotkey cap is wider than a digit's fixed 16px square — let it size
  // to its text while keeping the brass-cap look.
  keyEl.style.width = "auto";
  keyEl.style.padding = "0 6px";

  if (againRow.state === "unmarked") {
    entry.style.opacity = "0.45";
    const labelEl = entry.querySelector(".capture-picker-entry-label");
    labelEl.style.textDecoration = "line-through";
    labelEl.textContent = `${againRow.label} — gone`;
  }
  return entry;
}

// A row click IS a press of the row's key (issue #61, ADR 0005): it ships the
// row's identity — bound to the render that built it, so a click can never
// act on a stale or reordered target list — over IPC to main, where the
// picker handle dispatches the exact selection event the key would produce.
// Rows are pure buttons: their column lives outside the card, so a press here
// never begins the window-drag gesture (the butler/header keeps that role),
// and an unmarked again-row still clicks — the same truthful no-op its key is.
function makeRowClickable(entry, identity) {
  entry.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    window.mistrFlow.sendPickerRowClick(identity);
  });
}

function renderCapturePickerEntries(snapshot) {
  pickerEntriesEl.textContent = "";
  if (snapshot.phase !== "capture-picker") return;

  if (snapshot.againRow) {
    const againEl = buildAgainRowEl(snapshot.againRow);
    makeRowClickable(againEl, { kind: "again" });
    pickerEntriesEl.appendChild(againEl);
  }
  // Slot 1 is the pinned local outcome in every verb (#64): Capture and Relay
  // both read the "Clipboard" default (Relay's = keep the copy, stop here);
  // Herald relabels it "Paste here" via slotOneLabel (issue #55). Panes occupy
  // digits 2–9 either way; clipboardSlot === false stays renderable but no
  // verb sends it today.
  if (snapshot.clipboardSlot !== false) {
    const slotOneEl = buildPickerEntryEl(1, snapshot.slotOneLabel || "Clipboard");
    makeRowClickable(slotOneEl, { kind: "clipboard" });
    pickerEntriesEl.appendChild(slotOneEl);
  }
  for (const [index, target] of (snapshot.captureTargets || []).entries()) {
    const entryEl = buildPickerEntryEl(index + 2, target.label);
    makeRowClickable(entryEl, { kind: "target", slotIndex: index });
    pickerEntriesEl.appendChild(entryEl);
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
  renderDoneBadge(snapshot);
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
