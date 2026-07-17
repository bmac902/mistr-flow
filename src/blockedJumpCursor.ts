// The pure cycle logic behind the jump gesture (issue #50, PRD #44; redefined
// one level up by #79 / ADR 0006 §4): given an ordered list of targets from
// fleetState, pick the next pane to jump to. All the "repeat presses cycle,
// oldest first" and "a died target is skipped, never landed on" behaviour lives
// here so it can be driven directly in tests — no Herdr, no globalShortcut, no
// clock. The gesture now means "take me to what most needs my attention next":
// {@link attentionCycle} composes the one unified order the cursor walks.

import type { FleetPosture } from "./fleetState";

/**
 * The one unified attention cycle the jump gesture walks (ADR 0006 §4): every
 * blocked target oldest-first, then every done target oldest-first. A bottleneck
 * always outranks a harvest. With anything blocked this is a strict extension of
 * the shipped blocked-only cycle (#50/#52) — the blocked prefix is byte-identical,
 * so muscle memory survives; with nothing blocked it is exactly the done list, so
 * the harvest path falls out of the same gesture instead of a new chord.
 */
export function attentionCycle(posture: FleetPosture): readonly string[] {
  return [...posture.blockedTargets, ...posture.doneTargets];
}

export interface BlockedJumpCursor {
  /**
   * Pick the next target to jump to for one hotkey press, advancing the cursor.
   *
   * `orderedBlocked` is the live longest-blocked-first list (fleetState's
   * `blockedTargets`) at the moment of the press. Returns:
   * - the oldest-blocked target on the first press (or after the set emptied),
   * - the target *after* the last one visited on a repeat press (wrapping to
   *   the oldest at the end),
   * - the oldest-blocked target when the last-visited target has since vanished
   *   — a dead pane is never returned,
   * - `null` when nothing is blocked, so the caller can no-op truthfully.
   */
  next(orderedBlocked: readonly string[]): string | null;
}

export function createBlockedJumpCursor(): BlockedJumpCursor {
  // The target the previous press landed on. Compared against the live list on
  // each press rather than trusting a stored index, so the cursor stays correct
  // as agents block and unblock between presses.
  let lastTarget: string | null = null;

  return {
    next(orderedBlocked) {
      if (orderedBlocked.length === 0) {
        // Nothing to jump to — a truthful no-op. Forget where we were so the
        // next real episode starts cleanly from its oldest agent.
        lastTarget = null;
        return null;
      }

      const lastIndex = lastTarget === null ? -1 : orderedBlocked.indexOf(lastTarget);
      // -1 covers both "first press" and "last target has died" — both
      // re-anchor to the oldest-blocked agent (index 0), never a dead pane.
      const nextIndex = lastIndex === -1 ? 0 : (lastIndex + 1) % orderedBlocked.length;

      const target = orderedBlocked[nextIndex];
      lastTarget = target;
      return target;
    },
  };
}
