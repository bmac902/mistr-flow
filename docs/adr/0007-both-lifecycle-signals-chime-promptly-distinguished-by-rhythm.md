# Both lifecycle signals chime promptly, distinguished by rhythm

Status: accepted (2026-07-19)

Amends ADR 0006 §§2–3 and §5. Issue #91.

Dogfooding the done chime exposed the asymmetry ADR 0006 designed in as a defect in daily use. *Done* chimes on the transition poll — immediate. *Blocked* had no immediate cue at all: its only sound was the persistent-block ding at `DEFAULT_PERSISTENT_BLOCK_MS = 240000`, four minutes in. Operating the fleet from another window, the operator got instant notification of the harmless signal and four minutes of silence on the urgent one.

The original reasoning was coherent — the ding was scoped as a *missed-bottleneck alarm*, not a *state-changed notification*, on the theory that the butler's posture carries Blocked ambiently and only a genuinely-missed bottleneck earns an interruption. What that reasoning assumed is that the operator can see the posture. In practice Mistr Flow is frequently not on screen, so the ambient channel is dark exactly when the cue matters, and a four-minute delay meant the operator had almost always already discovered the block by hand. The escalation was announcing a bottleneck to someone already staring at it.

A second, smaller finding: the two sounds were not actually distinguishable. 900 Hz vs 587 Hz, both single ~100 ms beeps. Pitch alone is hard to discriminate in isolation from another window — which is the only situation either cue exists for.

## Decisions

1. **Blocked chimes at the dwell crossing, not at four minutes.** The 5s `dwellMs` stays and keeps its ADR 0006 §5 job — filtering transient self-blocks, a real observed hazard class — but it now also gates the cue. The one-shot fires on exactly the poll a target enters `blockedTargets`, so the sound and the count can never disagree, and a block that resolves itself inside the dwell never makes a noise. Rejected: chiming with no dwell at all (mirroring Done) — Done has no transient class to filter, Blocked demonstrably does, so the asymmetry in §5 survives as a *dwell* asymmetry even though the *promptness* asymmetry is gone.

2. **The four-minute persistent-block ding is dropped, not kept alongside.** One cue per state change, never repeated, never escalating — ADR 0006 §2's grammar for Done, now applied to Blocked as well. Rejected: chime at 5s *and* nag at 4 min if still blocked. It doubles the sounds per block to catch a case (heard it, forgot it) that the ambient posture, the badge, and `Ctrl+Alt+J` already serve, and "never nags" is the governing principle of the whole alert surface. ADR 0006 §2's "a missed bottleneck compounds" argued for escalation; the counter-evidence is that the escalation fired so late it never actually caught the miss.

3. **Blocked is foreground-gated exactly like Done, sharing one probe.** No sound when Herdr's host window is already the OS foreground window — you can see it. Suppression consumes the cue for that episode (ADR 0006 §3), never deferred to a later alt-tab. The seam is `createHerdrForegroundCheck`, unchanged. Because it shells out to PowerShell (the spawn class #72 fixed), the wiring evaluates every cheap gate for *both* cues first and probes **at most once per poll**, never once per cue.

4. **The two cues are distinguished by rhythm, not pitch.** Done is one soft tone (587 Hz, 90 ms); Blocked is two quick beeps (900 Hz, 70 ms each) separated by 60 ms of silence. The gap is load-bearing, not cosmetic: `[console]::beep` is synchronous, so back-to-back calls with no sleep render as a single continuous tone. Rejected: widening the pitch gap while keeping both as single beeps — cheapest to build and the thing that had already failed in use.

5. **Blocked outranks Done when both fire on the same poll; Done stays silent that poll.** A bottleneck outranks a harvest (ADR 0006 §4's ordering, applied to sound), and two beep shell-outs racing each other interleave into noise rather than two legible cues. Rejected: sequencing both — the composite is unrecognisable as either. The swallowed completion is the same accepted edge as foreground suppression: the badge and the jump gesture remain the durable surface, the bell is a moment.

## Consequences

- **`newlyPersistentBlockedTargets` becomes `newlyBlockedTargets`**, firing on the dwell crossing. `persistentBlockMs` and `DEFAULT_PERSISTENT_BLOCK_MS` are gone; `dwellMs` is now the single "this block is real" threshold feeding the count, the jump cycle, and the cue alike. The `dinged` set becomes `blockAnnounced`, still kept in lockstep with `blockedSince` so a cleared block re-arms the one-shot.
- **`src/doneChime.ts` becomes `src/fleetChime.ts`** — the module owns both cues now, so the old name lied. `shouldChimeDone` generalises to one `shouldChime` taking `newlyTargets`; sounds are modelled as a `ChimePattern` (tones + gap) rather than a single `{hz, ms}` pair. `createHerdrForegroundCheck` is untouched.
- **Config: `blockedChime`, with `persistentBlockDing` still honoured.** Configs live per-machine at `%APPDATA%\MistrFlow\config.json`, outside the repo, so a silent rename would have un-silenced the cue on any machine that had already turned it off. Either key set to `false` silences it; the new name is the one to write. Both cues remain default-on, each reading its own flag — still no combined master switch.
- **Verifiability without audio.** Every assertion is made at the `execFile` seam against the rendered PowerShell command, never by ear — which is what lets the cue be tested at all in an environment with no sound device. The genuinely audible questions (are they tellable apart in practice, does the double beep read as urgent rather than annoying, is 60 ms enough separation on this hardware) are human verification on the host machine and deliberately not encoded as tests.
- **Unchanged**: posture and tiering stay a pure function of Blocked; the done badge; the unified `Ctrl+Alt+J` attention cycle; the standing boundary that MF learns no git/session/issue semantics; OS toasts still deferred until observed need.
- **Expected rhythm changes.** ADR 0006 predicted the done chime would be *rare* because Herdr is normally visible. Blocked chiming at 5s is a strictly louder app in the case where Herdr is hidden and several agents block in sequence. If that proves noisy, the lever is the dwell, not a return to escalation.
