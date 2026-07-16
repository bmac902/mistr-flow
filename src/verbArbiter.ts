export type Verb = "dictation" | "capture" | "relay" | "herald";

export interface ArbiterState {
  activeVerb: Verb | null;
}

export type ArbiterDecision = "start" | "refuse";

export function decideVerbStart(state: ArbiterState, requestedVerb: Verb): ArbiterDecision {
  return state.activeVerb === null ? "start" : "refuse";
}
