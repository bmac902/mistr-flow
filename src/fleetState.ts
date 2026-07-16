import type { WatchedAgent } from "./herdr";

// The pure heart of fleet awareness (PRD #44): it consumes a sequence of
// watched-set snapshots plus an injected clock and emits the ambient posture —
// no timers, no I/O, no Herdr. All dwell tracking, tier banding, unknown
// detection, and longest-blocked selection live here so they can be driven by a
// fake clock in tests, mirroring sessionIdleReturn / captureCrop.

/**
 * The ambient tier, driven by the *count* of agents blocked past the dwell
 * threshold. `unknown` is not a count — it's the honest "I can't see the fleet"
 * posture when a poll fails, deliberately distinct from the calm `0` (the app's
 * "absence of signal is not all-clear" epistemics).
 */
export type FleetTier = "unknown" | "0" | "1" | "2-3" | "4+";

export interface FleetPosture {
  readonly tier: FleetTier;
  /** How many agents are blocked past the dwell threshold (0 during unknown). */
  readonly blockedCount: number;
  /**
   * The durable target of the oldest continuously-blocked agent — the "most
   * needs you" jump target for the later slices (#50/#52). Null when nothing
   * has dwelt past the threshold. Best-effort even during `unknown` so a
   * transient poll failure doesn't strand the jump action. Always equal to
   * `blockedTargets[0] ?? null`.
   */
  readonly longestBlockedTarget: string | null;
  /**
   * Every agent blocked past the dwell threshold, oldest continuously-blocked
   * first (ties broken by target id for determinism). This is the jump-cycle
   * order the hotkey (#50) walks — repeat presses step through it oldest-first.
   * Empty when nothing has dwelt past the threshold.
   */
  readonly blockedTargets: readonly string[];
}

/** One poll's outcome: a watched-set snapshot, or an unreachable Herdr. */
export type FleetPoll =
  | { readonly kind: "panes"; readonly agents: readonly WatchedAgent[] }
  | { readonly kind: "unavailable" };

export interface FleetStateOptions {
  /**
   * How long an agent must be *continuously* blocked before it counts. Spike
   * calibration: real blocks hold tens of seconds to minutes and no transient
   * flickers were seen, so a short dwell catches every real block while
   * filtering any hypothetical blip.
   */
  readonly dwellMs?: number;
}

export interface FleetState {
  /** Fold one poll into the tracker and return the resulting posture. */
  observe(poll: FleetPoll, nowMs: number): FleetPosture;
  /** The current posture without advancing the tracker. */
  posture(): FleetPosture;
}

export const DEFAULT_DWELL_MS = 5000;

export function createFleetState(options: FleetStateOptions = {}): FleetState {
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;

  // target → the timestamp the agent first became continuously blocked. An
  // agent leaves this map the moment it's no longer blocked (status changed or
  // pane vanished), which re-arms the dwell timer for any future block.
  const blockedSince = new Map<string, number>();
  let reachable = false;
  let lastNowMs = 0;

  function computePosture(): FleetPosture {
    // Collect every agent past the dwell threshold, then order it oldest-first
    // (ties broken by target id) so both the count and the jump-cycle list fall
    // out of one deterministic sort.
    const dwelt: Array<{ readonly target: string; readonly since: number }> = [];
    for (const [target, since] of blockedSince) {
      if (lastNowMs - since < dwellMs) continue;
      dwelt.push({ target, since });
    }
    dwelt.sort((a, b) =>
      a.since !== b.since ? a.since - b.since : a.target < b.target ? -1 : 1,
    );
    const blockedTargets = dwelt.map((entry) => entry.target);

    return {
      tier: reachable ? tierForCount(blockedTargets.length) : "unknown",
      blockedCount: blockedTargets.length,
      longestBlockedTarget: blockedTargets[0] ?? null,
      blockedTargets,
    };
  }

  return {
    observe(poll, nowMs) {
      lastNowMs = nowMs;

      if (poll.kind === "unavailable") {
        // Absence of signal is not "all clear" — surface `unknown`. Preserve the
        // dwell timers rather than resetting them, so a poll that recovers with
        // an agent still blocked keeps its elapsed dwell instead of restarting.
        reachable = false;
        return computePosture();
      }

      reachable = true;
      const stillBlocked = new Set<string>();
      for (const agent of poll.agents) {
        if (agent.status !== "blocked") continue;
        stillBlocked.add(agent.target);
        if (!blockedSince.has(agent.target)) blockedSince.set(agent.target, nowMs);
      }

      for (const target of [...blockedSince.keys()]) {
        if (!stillBlocked.has(target)) blockedSince.delete(target);
      }

      return computePosture();
    },

    posture() {
      return computePosture();
    },
  };
}

function tierForCount(count: number): FleetTier {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2-3";
  return "4+";
}
