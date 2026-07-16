import type { CaptureDeliverOutcome } from "./captureSession";
import type { EligibleTarget } from "./herdr";

// The Last Target memory (issue #58, ADR 0004; glossary in CONTEXT.md): the
// single most-recently delivered-to Eligible Target, shared across ALL send
// verbs — "the agent I'm working with right now" is a property of the user's
// attention, not of the verb carrying the payload, so Capture, Relay, and
// Herald all update (and repeat to) the same one memory.
//
// Lifetime is deliberate: no time-based expiry (the visible again-row mark,
// not a clock, is the staleness defense), no restart persistence (in-process
// only — fire-and-forget, nothing persisted beyond config), validated at use
// (reconciled against the fresh pane query; a confirm to a since-dead pane
// fails truthfully through the ordinary delivery failure).

export interface LastTargetMemory {
  /** Replaces the memory — one Last Target, never a history. */
  record(target: EligibleTarget): void;
  /** The remembered target, or null (fresh launch — no again-row). */
  current(): EligibleTarget | null;
}

export function createLastTargetMemory(): LastTargetMemory {
  let last: EligibleTarget | null = null;
  return {
    record(target: EligibleTarget): void {
      last = target;
    },
    current(): EligibleTarget | null {
      return last;
    },
  };
}

/**
 * Wraps a verb's `deliver` dependency so a confirmed `delivered` ack — and
 * only that — records the pane as the Last Target. Delivery-unknown and
 * delivery-failed never update it (unknown is not success), and slot-1
 * outcomes (Clipboard / paste-here) structurally can't reach it: they never
 * go through `deliver` at all. Wrapping the shared delivery adapter once in
 * main.ts is what makes the memory verb-agnostic — every verb's delivered
 * ack lands here.
 */
export function withLastTargetRecording<P>(
  deliver: (payload: P, target: EligibleTarget) => Promise<CaptureDeliverOutcome>,
  memory: LastTargetMemory,
): (payload: P, target: EligibleTarget) => Promise<CaptureDeliverOutcome> {
  return (payload, target) =>
    deliver(payload, target).then((outcome) => {
      if (outcome.kind === "delivered") {
        memory.record(target);
      }
      return outcome;
    });
}
