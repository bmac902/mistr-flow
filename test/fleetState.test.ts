import assert from "node:assert/strict";
import test from "node:test";

import { createFleetState, type FleetPoll } from "../src/fleetState";
import type { WatchedAgent, WatchedAgentStatus } from "../src/herdr";

function agent(
  target: string,
  status: WatchedAgentStatus,
  name = target,
): WatchedAgent {
  return { target, agent: name, status };
}

function panes(...agents: WatchedAgent[]): FleetPoll {
  return { kind: "panes", agents };
}

const UNAVAILABLE: FleetPoll = { kind: "unavailable" };

test("a block under the dwell threshold never counts toward the tier", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  // Seen blocked at t=0…
  let posture = fleet.observe(panes(agent("term_A", "blocked")), 0);
  assert.equal(posture.tier, "0");
  assert.equal(posture.blockedCount, 0);
  assert.equal(posture.longestBlockedTarget, null);

  // …still blocked at t=4999, just short of the dwell threshold.
  posture = fleet.observe(panes(agent("term_A", "blocked")), 4999);
  assert.equal(posture.tier, "0");
  assert.equal(posture.longestBlockedTarget, null);
});

test("a block past the dwell threshold advances the tier to 1 and names the target", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe(panes(agent("term_A", "blocked")), 0);
  const posture = fleet.observe(panes(agent("term_A", "blocked")), 5000);

  assert.equal(posture.tier, "1");
  assert.equal(posture.blockedCount, 1);
  assert.equal(posture.longestBlockedTarget, "term_A");
});

test("multiple dwelling-blocked agents map to the right tier bands", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  const three = [
    agent("a", "blocked"),
    agent("b", "blocked"),
    agent("c", "blocked"),
  ];
  fleet.observe(panes(...three), 0);
  let posture = fleet.observe(panes(...three), 5000);
  assert.equal(posture.blockedCount, 3);
  assert.equal(posture.tier, "2-3");

  const four = [...three, agent("d", "blocked")];
  fleet.observe(panes(...four), 6000);
  // 'd' first seen at 6000; it dwells past threshold at 11000.
  posture = fleet.observe(panes(...four), 11000);
  assert.equal(posture.blockedCount, 4);
  assert.equal(posture.tier, "4+");
});

test("non-blocked statuses never count, whatever they are", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  const mixed = panes(
    agent("a", "idle"),
    agent("b", "working"),
    agent("c", "done"),
    agent("d", "unknown"),
  );
  fleet.observe(mixed, 0);
  const posture = fleet.observe(mixed, 10000);

  assert.equal(posture.blockedCount, 0);
  assert.equal(posture.tier, "0");
});

test("a failed poll yields the unknown tier, distinct from a calm 0", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  // Establish a genuine 0-blocked baseline first.
  const calm = fleet.observe(panes(agent("a", "idle")), 0);
  assert.equal(calm.tier, "0");

  const unknown = fleet.observe(UNAVAILABLE, 1000);
  assert.equal(unknown.tier, "unknown");
  assert.notEqual(unknown.tier, calm.tier);
});

test("a transient failed poll preserves dwell timers so a recovered block still counts", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe(panes(agent("a", "blocked")), 0);
  // Poll fails mid-dwell — the tier is unknown but the timer must not reset.
  const dropped = fleet.observe(UNAVAILABLE, 3000);
  assert.equal(dropped.tier, "unknown");

  // Poll recovers at 5000; the agent has been blocked continuously since 0.
  const recovered = fleet.observe(panes(agent("a", "blocked")), 5000);
  assert.equal(recovered.tier, "1");
  assert.equal(recovered.longestBlockedTarget, "a");
});

test("longest-blocked selection returns the oldest continuously-blocked agent", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe(panes(agent("older", "blocked")), 0);
  fleet.observe(panes(agent("older", "blocked"), agent("newer", "blocked")), 2000);
  const posture = fleet.observe(
    panes(agent("older", "blocked"), agent("newer", "blocked")),
    8000,
  );

  assert.equal(posture.blockedCount, 2);
  assert.equal(posture.tier, "2-3");
  assert.equal(posture.longestBlockedTarget, "older");
});

test("blockedTargets lists every dwelling-blocked agent oldest-first, and leads with longestBlockedTarget", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe(panes(agent("older", "blocked")), 0);
  fleet.observe(
    panes(agent("older", "blocked"), agent("newer", "blocked")),
    2000,
  );
  const posture = fleet.observe(
    panes(agent("older", "blocked"), agent("newer", "blocked")),
    8000,
  );

  assert.deepEqual(posture.blockedTargets, ["older", "newer"]);
  assert.equal(posture.blockedTargets[0], posture.longestBlockedTarget);
});

test("blockedTargets excludes agents still under the dwell threshold", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe(panes(agent("early", "blocked")), 0);
  // 'late' only just blocked at 8000 — not yet dwelt when we read at 8000.
  const posture = fleet.observe(
    panes(agent("early", "blocked"), agent("late", "blocked")),
    8000,
  );

  assert.deepEqual(posture.blockedTargets, ["early"]);
});

test("blockedTargets is empty when nothing is blocked past the threshold", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  const posture = fleet.observe(panes(agent("a", "idle")), 10000);
  assert.deepEqual(posture.blockedTargets, []);
});

test("a block that clears re-arms the dwell timer on the next block", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe(panes(agent("a", "blocked")), 0);
  let posture = fleet.observe(panes(agent("a", "blocked")), 5000);
  assert.equal(posture.tier, "1");

  // Answered — the agent is idle again.
  posture = fleet.observe(panes(agent("a", "idle")), 6000);
  assert.equal(posture.tier, "0");
  assert.equal(posture.longestBlockedTarget, null);

  // Blocks again at 7000; must not instantly re-count on the old timer.
  posture = fleet.observe(panes(agent("a", "blocked")), 7000);
  assert.equal(posture.tier, "0");

  // Only once the fresh dwell elapses (7000 + 5000).
  posture = fleet.observe(panes(agent("a", "blocked")), 12000);
  assert.equal(posture.tier, "1");
});

test("the persistent-block signal fires once at the duration and never before it", () => {
  const fleet = createFleetState({ dwellMs: 5000, persistentBlockMs: 240000 });

  // Blocked continuously from t=0. Well past the dwell threshold but short of
  // the persistent-block duration — no ding yet.
  fleet.observe(panes(agent("a", "blocked")), 0);
  let posture = fleet.observe(panes(agent("a", "blocked")), 60000);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, []);

  posture = fleet.observe(panes(agent("a", "blocked")), 239999);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, []);

  // Crosses the persistent-block duration — fires exactly here.
  posture = fleet.observe(panes(agent("a", "blocked")), 240000);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, ["a"]);
});

test("the persistent-block signal fires exactly once per episode, not on later polls", () => {
  const fleet = createFleetState({ dwellMs: 5000, persistentBlockMs: 240000 });

  fleet.observe(panes(agent("a", "blocked")), 0);
  let posture = fleet.observe(panes(agent("a", "blocked")), 240000);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, ["a"]);

  // Still blocked on the next polls — the one-shot must not re-fire.
  posture = fleet.observe(panes(agent("a", "blocked")), 243500);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, []);
  posture = fleet.observe(panes(agent("a", "blocked")), 600000);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, []);
});

test("the persistent-block signal re-arms only after the block clears", () => {
  const fleet = createFleetState({ dwellMs: 5000, persistentBlockMs: 240000 });

  fleet.observe(panes(agent("a", "blocked")), 0);
  let posture = fleet.observe(panes(agent("a", "blocked")), 240000);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, ["a"]);

  // Answered — the block clears.
  fleet.observe(panes(agent("a", "idle")), 250000);

  // Blocks again; the fresh episode's ding is armed and fires only after a
  // fresh full persistent-block duration, not instantly on the old timer.
  fleet.observe(panes(agent("a", "blocked")), 300000);
  posture = fleet.observe(panes(agent("a", "blocked")), 539999);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, []);
  posture = fleet.observe(panes(agent("a", "blocked")), 540000);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, ["a"]);
});

test("posture() is a pure read and never emits the one-shot persistent-block signal", () => {
  const fleet = createFleetState({ dwellMs: 5000, persistentBlockMs: 240000 });

  fleet.observe(panes(agent("a", "blocked")), 0);
  const observed = fleet.observe(panes(agent("a", "blocked")), 240000);
  assert.deepEqual(observed.newlyPersistentBlockedTargets, ["a"]);

  // Reading the posture again must not surface the (already-consumed) signal.
  assert.deepEqual(fleet.posture().newlyPersistentBlockedTargets, []);
});

test("a persistent block that vanishes before its ding never fires it", () => {
  const fleet = createFleetState({ dwellMs: 5000, persistentBlockMs: 240000 });

  fleet.observe(panes(agent("a", "blocked")), 0);
  // Pane closed just short of the persistent-block duration.
  const posture = fleet.observe(panes(), 239000);
  assert.deepEqual(posture.newlyPersistentBlockedTargets, []);
});

test("a vanished blocked agent drops out of the count", () => {
  const fleet = createFleetState({ dwellMs: 5000 });

  fleet.observe(panes(agent("a", "blocked"), agent("b", "blocked")), 0);
  let posture = fleet.observe(
    panes(agent("a", "blocked"), agent("b", "blocked")),
    5000,
  );
  assert.equal(posture.blockedCount, 2);

  // 'b' closed its pane — gone from the snapshot entirely.
  posture = fleet.observe(panes(agent("a", "blocked")), 6000);
  assert.equal(posture.blockedCount, 1);
  assert.equal(posture.longestBlockedTarget, "a");
});
