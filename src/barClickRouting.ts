// The pure routing decision behind a click on the bar (issue #61, ADR 0005).
// At rest, a bar click jumps to the longest-blocked agent (issue #52). While a
// picker is open the window is modal: rows are buttons, the butler/header is
// purely a window handle, and the jump is suppressed — a mid-pick jump would
// yank OS focus to some blocked pane in the middle of choosing a destination,
// exactly the ambiguity ADR 0005 exists to remove. Suppression is deliberately
// scoped to picker-open, not every mid-flight verb: the resting bar outside a
// picker keeps today's behavior, restored the moment the picker closes.
//
// Pure by design (no DOM, no IPC, no Electron) so the decision is unit-tested
// here and main.ts's bar-clicked handler stays a thin effect layer.

export type BarClickRoute = "jump" | "suppressed";

export interface BarClickContext {
  /** Whether any verb's picker is open right now. */
  readonly pickerOpen: boolean;
}

export function routeBarClick(context: BarClickContext): BarClickRoute {
  return context.pickerOpen ? "suppressed" : "jump";
}
