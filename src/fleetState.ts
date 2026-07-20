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
  /**
   * The one-shot "newly blocked" signal (#91): agents that crossed the *dwell*
   * threshold on this observe — the moment a bottleneck is worth announcing.
   * Fires exactly once per continuous-block episode (re-armed only after the
   * block clears) and only from `observe`; `posture()` always reports it empty
   * so a passive read never re-triggers the chime. The effectful layer decides
   * whether to actually sound it (config + verb + foreground suppression) —
   * this module stays pure.
   *
   * Always exactly the set of targets *entering* {@link blockedTargets} on this
   * observe: announcing at the dwell crossing is what makes the cue prompt
   * (ADR 0007) while still filtering the transient self-blocks the dwell exists
   * to catch. It replaces the old 4-minute persistent-block one-shot, which
   * announced a bottleneck so late the operator had usually already found it.
   */
  readonly newlyBlockedTargets: readonly string[];
  /**
   * How many watched panes are currently `done` — finished and unattended
   * (glossary *Done*; ADR 0006 §1). Unlike {@link blockedCount} there is **no
   * dwell**: a done appears the same observe it's reported (see the asymmetry
   * note on the done-episode tracking below). Preserved (not invented) during
   * `unknown`, exactly like the blocked best-effort selection.
   */
  readonly doneCount: number;
  /**
   * Every currently-done target, oldest-episode-first (ties broken by target id
   * for determinism — mirrors the blocked ordering rule). This is the done half
   * of the unified attention cycle the jump gesture walks (#79). Empty when
   * nothing is done.
   */
  readonly doneTargets: readonly string[];
  /**
   * The one-shot "newly done" signal: targets that began a done episode on
   * *this* observe — the moment a completion is worth announcing (#80's chime).
   * Fires exactly once per done-episode (re-armed only after the episode clears)
   * and only from `observe`; `posture()` always reports it empty so a passive
   * read never re-triggers the chime. Mirrors
   * {@link newlyBlockedTargets}; the effectful layer decides what to
   * do with it — this module stays pure.
   */
  readonly newlyDoneTargets: readonly string[];
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
   *
   * Since #91 this is also when the blocked chime fires — the dwell is the
   * single "this block is real" threshold, feeding the count, the jump cycle,
   * and the cue alike.
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
  // Blocked targets whose one-shot newly-blocked emission has already fired for
  // their *current* episode. Kept in lockstep with blockedSince (an entry is
  // dropped the moment its block clears), so a fresh block re-arms the one-shot.
  const blockAnnounced = new Set<string>();
  // target → the timestamp a watched agent's *current* done episode began. An
  // agent leaves this map the moment it's no longer done (status changed or pane
  // vanished — Herdr owns the lifecycle), which re-arms the episode. Deliberately
  // **no dwell** here, a principled asymmetry with Blocked (ADR 0006 §5): the
  // dwell filters transient self-blocks, but an unattended done cannot self-clear
  // so there is no transient class to filter — a dwell would only add latency.
  const doneSince = new Map<string, number>();
  // Done targets whose one-shot newly-done emission has already fired for their
  // *current* episode. Kept in lockstep with doneSince (dropped when the episode
  // clears), so a fresh done episode re-arms the one-shot — same class of
  // episode-scoped presentation memory as `blockAnnounced` beside `blockedSince`.
  const doneAnnounced = new Set<string>();
  let reachable = false;
  let lastNowMs = 0;

  function computePosture(
    newlyBlockedTargets: readonly string[] = [],
    newlyDoneTargets: readonly string[] = [],
  ): FleetPosture {
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

    // Done needs no dwell filter — every current done episode counts, ordered
    // oldest-episode-first (ties by target id) by the same deterministic rule.
    const doneEpisodes = [...doneSince.entries()].map(([target, since]) => ({
      target,
      since,
    }));
    doneEpisodes.sort((a, b) =>
      a.since !== b.since ? a.since - b.since : a.target < b.target ? -1 : 1,
    );
    const doneTargets = doneEpisodes.map((entry) => entry.target);

    return {
      tier: reachable ? tierForCount(blockedTargets.length) : "unknown",
      blockedCount: blockedTargets.length,
      longestBlockedTarget: blockedTargets[0] ?? null,
      blockedTargets,
      newlyBlockedTargets,
      doneCount: doneTargets.length,
      doneTargets,
      newlyDoneTargets,
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
      const stillDone = new Set<string>();
      for (const agent of poll.agents) {
        if (agent.status === "blocked") {
          stillBlocked.add(agent.target);
          if (!blockedSince.has(agent.target)) blockedSince.set(agent.target, nowMs);
        } else if (agent.status === "done") {
          stillDone.add(agent.target);
          if (!doneSince.has(agent.target)) doneSince.set(agent.target, nowMs);
        }
      }

      for (const target of [...blockedSince.keys()]) {
        if (!stillBlocked.has(target)) {
          blockedSince.delete(target);
          // Block cleared → re-arm the chime for this target's next episode.
          blockAnnounced.delete(target);
        }
      }

      // Done episodes end independently of blocked ones on the same snapshot.
      for (const target of [...doneSince.keys()]) {
        if (!stillDone.has(target)) {
          doneSince.delete(target);
          // Episode cleared → re-arm the newly-done one-shot for the next one.
          doneAnnounced.delete(target);
        }
      }

      // The newly-done one-shot: any done target whose episode we haven't yet
      // announced fires exactly now. Only reached from a confirmed snapshot, so
      // nothing is invented while blind.
      const newlyDone: Array<{ readonly target: string; readonly since: number }> = [];
      for (const [target, since] of doneSince) {
        if (doneAnnounced.has(target)) continue;
        doneAnnounced.add(target);
        newlyDone.push({ target, since });
      }
      newlyDone.sort((a, b) =>
        a.since !== b.since ? a.since - b.since : a.target < b.target ? -1 : 1,
      );

      // The newly-blocked one-shot is evaluated only on a confirmed snapshot: an
      // agent we can't currently see blocked never earns a cue. Any target past
      // the dwell that hasn't yet announced this episode fires exactly now — the
      // same crossing that admits it to `blockedTargets`, so the cue and the
      // count can never disagree. A block that clears inside the dwell never
      // reaches here at all, which is the transient-self-block filter.
      const newlyBlocked: Array<{ readonly target: string; readonly since: number }> = [];
      for (const [target, since] of blockedSince) {
        if (nowMs - since < dwellMs) continue;
        if (blockAnnounced.has(target)) continue;
        blockAnnounced.add(target);
        newlyBlocked.push({ target, since });
      }
      newlyBlocked.sort((a, b) =>
        a.since !== b.since ? a.since - b.since : a.target < b.target ? -1 : 1,
      );

      return computePosture(
        newlyBlocked.map((entry) => entry.target),
        newlyDone.map((entry) => entry.target),
      );
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
