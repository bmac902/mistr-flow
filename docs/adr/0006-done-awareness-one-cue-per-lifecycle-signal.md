# Done-awareness — one active cue per lifecycle signal

Status: accepted (2026-07-16)

The need surfaced as a workaround caught in the act: telling a monitoring agent "when the job is done, block on a question to me" — manufacturing an artificial *blocked* state purely so fleet awareness would notice a *completion*. Herdr already reports `done` as a first-class agent status; MF's own adapter already types it and the Watched Set already carries it. PRD #44 deferred done-awareness on a reliability worry ("done appears in only one of Herdr's two status enums"). A live calibration spike (2026-07-16, 10 minutes, 5s cadence, this machine) retired that worry and pinned the semantics:

- `done` fires reliably on turn end and **holds without flicker** — one unharvested agent sat `done` for the entire window.
- It clears on **engagement** (typing in the pane), *not* on focus — a focused pane sat `done` for minutes until input arrived.
- A turn that ends while input is already pending skips `done` entirely — so `done` genuinely means **finished and unattended**.
- The enum gap is request-side only (`PaneAgentState`); every response/event enum carries `done`, including the `pane list` poll MF already runs.

## Decisions

1. **Bind to Herdr's `done` status directly — Herdr owns the lifecycle.** No `working → idle` inference, no MF-side visited/seen tracking. MF keeps only *episode-scoped presentation memory* (a `doneSince` clock for ordering, a one-shot flag for the chime) — the same class of state the persistent-block ding already holds (`blockedSince`/`dinged`), re-armed when the episode clears. Rejected: an "unseen completions" badge with MF-side seen-tracking — an unread-message system MF doesn't need, and a second source of truth that can disagree with Herdr. The accepted consequence, eyes open: *reading* a done pane without engaging doesn't clear its signal — "waiting to be harvested" is still true until you act.

2. **The alert grammar is amended: one active cue per lifecycle signal, never repeated, never escalating.** PRD #44's "the ding is the only interruption" becomes per-signal. *Blocked* keeps its full grammar untouched — posture, fleet count, the escalating persistent-block ding — because a missed bottleneck compounds. *Done* earns exactly **one soft chime** (a distinct, gentler sound than the ding) at the moment of the transition, once per done-episode, mutable in config, verb-suppressed. Rejected: done riding the blocked machinery (a completed agent is not a bottleneck — the workaround this feature exists to kill *was* that conflation); strictly-ambient done (misses the driving use case — being told, once, while heads-down elsewhere).

3. **The chime is foreground-gated, precisely, and suppression consumes it.** It fires only when *Herdr's specific host window* is not the OS foreground window at the transition — "your work is ready and you aren't looking at Herdr" — reusing ADR 0002's minted-title host-window identification (find the HWND once, compare cheaply per event, re-identify on staleness). Rejected: a coarse "foreground process is a terminal" probe — multiple terminal windows are routinely open, so the approximation would silently suppress exactly the alert the feature exists for; per-pane `focused` suppression — the spike proved Herdr-focused ≠ attended (a focused pane in a backgrounded Herdr is unseen, and a freshly-launched pane spawns focused — the flagship case would never chime); deferring a suppressed chime until Herdr loses foreground — a delayed surprise bell is the nagging this design keeps refusing. Suppression affects the audible cue only, never the recorded state or the badge.

4. **The jump gesture is redefined one level up: "take me to what most needs my attention next."** `Ctrl+Alt+J` and bar-click walk **one unified cycle: blocked panes oldest-first, then done panes oldest-first**. A bottleneck always outranks a harvest. With anything blocked, behavior is byte-identical to #50/#52 — a strict extension, so shipped muscle memory survives. With nothing blocked, the gesture lands on the oldest done pane and repeat presses cycle the rest — the harvest path falls out of the existing gesture instead of earning a new chord.

5. **Posture stays a pure function of Blocked; Done's ambient rendering is a plain count.** The butler's bearing is the *bottleneck* instrument — Done is structurally barred from it, the same way slot-1 outcomes are barred from Last Target. The badge is a renderer-owned count of current done panes on the idle bar (placeholder look now, Claude Design blessing later — the #44 pattern; no emoji). **No dwell — a principled asymmetry with Blocked**: the 5s blocked dwell filters transient self-blocks, a real observed hazard class; Done has no transient class, because an unattended done cannot clear itself. A dwell would add latency and filter nothing.

**Governing principle:** the butler asks *"who needs you?"*; the badge answers *"what have you finished?"* — two orthogonal channels, and neither ever nags. The fast path from a completion is `chime → Ctrl+Alt+J`, with the truth ambient in between.

## Consequences

- **Mostly a fleetState extension.** The pure module grows done-episode tracking beside its blocked tracking; the chime decision is emitted like the ding decision (one-shot, effects decided in the wiring). One new seam: an injected "is Herdr's host window foreground" check, faked in tests.
- **One new sound asset** — softer and distinct from the persistent-block ding. Config: `doneChime` (default on), riding the existing fleet-awareness master switch, mirroring the ding's flag shape.
- **OS toasts are deferred, not rejected** — added on *observed* need (completions missed while Herdr hidden), never anticipated need.
- **"Why it's done" enrichment is out on a standing boundary**: MF learns no git/session/issue semantics. The knowledge lives in Control Room; if enriched completions ever happen, CR pushes text down to a dumb MF display. See the PRD #44 vision arc.
- **Done panes as *delivery targets* is deliberately separate** (#76): a picker/delivery concern with its own live verification (auto-attach on a done prompt), not part of the notification work.
- **Accepted edge:** a done that occurs while Herdr is foreground never chimes later, even if it sits unharvested for an hour — the badge and the jump key are the durable surface, the bell is a moment.
