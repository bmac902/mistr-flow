// The pure click-vs-drag disambiguation behind the clickable bar (issue #52,
// PRD #44). A pointer press on the overlay can mean two things: a plain *click*
// (jump to the longest-blocked agent) or a *drag* (reposition the overlay).
// This module decides which, purely from the pointer's travel — no DOM, no IPC —
// so the threshold logic can be driven directly in tests.
//
// A gesture stays a "click" until the pointer travels more than the threshold
// from where it went down; once it crosses, it is a "drag" for the rest of the
// interaction (it never reverts, even if the pointer wanders back). The move()
// stream yields the overlay delta to apply: nothing while still a click, then —
// on the crossing move — the whole displacement from the origin so the overlay
// catches up to the pointer with no offset, and incremental deltas thereafter.
// That keeps repositioning tracking the pointer exactly as it did before.

export const DRAG_THRESHOLD_PX = 4;

export interface OverlayDelta {
  deltaX: number;
  deltaY: number;
}

export interface ClickDragGesture {
  /**
   * Feed the pointer's current position (screen coords). Returns the overlay
   * delta to apply for this move — {0,0} while the gesture is still a click,
   * the full displacement from the origin on the move that crosses the
   * threshold, and the incremental step on every drag move after that.
   */
  move(x: number, y: number): OverlayDelta;
  /**
   * End the gesture. `"drag"` if the pointer ever crossed the threshold (the
   * overlay was being repositioned), `"click"` otherwise (a plain click that
   * should invoke the bar's action).
   */
  end(): "click" | "drag";
}

const NO_MOVEMENT: OverlayDelta = { deltaX: 0, deltaY: 0 };

export function createClickDragGesture(
  originX: number,
  originY: number,
  threshold: number = DRAG_THRESHOLD_PX,
): ClickDragGesture {
  let isDrag = false;
  // Where the overlay has been moved to track the pointer so far. Only
  // meaningful once the gesture is a drag; seeded at the crossing move.
  let trackedX = originX;
  let trackedY = originY;

  return {
    move(x, y) {
      if (!isDrag) {
        const distance = Math.hypot(x - originX, y - originY);
        if (distance <= threshold) {
          // Still within the dead zone — a click, not (yet) a drag.
          return NO_MOVEMENT;
        }
        // The threshold is crossed: this is a drag from here on. Catch the
        // overlay up to the pointer in one step so there is no dead-zone offset.
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
