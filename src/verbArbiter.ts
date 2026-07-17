export type Verb = "dictation" | "capture" | "relay" | "herald";

export interface ArbiterState {
  activeVerb: Verb | null;
  /**
   * True while the active verb sits in an OPEN picker awaiting selection —
   * main.ts reads this off its picker-open hook (non-null exactly while a
   * picker is open). Busy states (recording, delivering, mid-polish) have no
   * picker and never set it.
   */
  pickerOpen?: boolean;
}

export type ArbiterDecision = "start" | "refuse" | "switch";

/**
 * One modal gesture at a time — but an open picker is a MENU, not work
 * (amended 2026-07-17): a *different* verb's key while a picker is open means
 * the user changed their mind, so the picker yields ("switch": cancel it,
 * start the intended verb) instead of trapping them behind Esc — a stray Esc
 * lands in the focused pane and kills real coding sessions. Everything the
 * refusal actually protects still refuses: recording (speech is never
 * interrupted), delivering (un-cancellable by design), processing — none of
 * which have a picker open. A same-verb press never reaches this decision
 * while a picker is open (main routes it to the again-confirm first, ADR
 * 0004); reaching here same-verb means a busy state → refuse.
 */
export function decideVerbStart(state: ArbiterState, requestedVerb: Verb): ArbiterDecision {
  if (state.activeVerb === null) return "start";
  if (state.activeVerb !== requestedVerb && state.pickerOpen) return "switch";
  return "refuse";
}
