# Handoff → work laptop, 2026-07-20: fleet chimes standardised + capture history shipped

**Tracked on purpose** (`git add -f`, same as the 2026-07-17 and 2026-07-18 handoffs) so it survives the pull to the work machine. Written for the agent that boots there next.

## Start here, in order

1. **`git remote -v` — do this FIRST, before pulling.** This repo has **two** remotes, and everything below landed on only one of them:

   ```
   origin      github.com/bmac902/mistr-flow                  ← main tracks this; has all the work
   blairfork   github.com/Blair-MacDonald_questsw/mistr-flow  ← work-account fork; NOT updated
   ```

   From the home machine, `blairfork` cannot even be fetched — the attempt hangs and times out, consistent with a work-account remote this machine can't authenticate to. **If this clone's `main` tracks `blairfork`, a plain `git pull` returns nothing and the sync silently looks like it worked.** Point at `origin`/`bmac902` (or fetch it explicitly) before doing anything else.

2. **`git pull`** — brings 3 commits: the chime fix, the ADR-0008 design doc, and the four-issue batch merge (#97).

3. **`npm install`** — dependencies are *unchanged* since 2026-07-17, so this is likely a no-op. Run it anyway; it is cheap, and this machine may be further behind than the home machine's history shows.

4. **`npm start`** (= `npm run build && electron .`) — **`dist/` is gitignored, so a fresh pull has no build.** This is the step people skip. Re-run `install:shortcut` if the folder moved.

5. **Check the chime config key** — see the config trap below. If this machine has `persistentBlockDing: false`, the new blocked chime will be silent and will look broken.

## The config trap (read before reporting a bug)

The blocked chime reads a **new** `blockedChime` key. The pre-#91 name `persistentBlockDing` is **still honoured on read**, deliberately: configs are per-machine at `%APPDATA%\MistrFlow\config.json`, outside the repo, so a silent rename would have un-silenced the cue on any machine that had already turned it off.

Consequence: **either key set to `false` silences the blocked chime.** If this machine has `persistentBlockDing: false` sitting in its config from an earlier session, Blocked will be silent after this pull and it will look like #91 shipped broken. Delete that key, or set `blockedChime: true`.

Both cues default on. Each reads its own flag; there is no combined master switch.

## What shipped (2026-07-19 → 2026-07-20 home session)

**#91 — both lifecycle signals chime promptly, distinguished by rhythm.** Blocked used to make *no* immediate sound at all: its only cue was the persistent-block ding at 4 minutes, while Done chimed instantly. That asymmetry was deliberate (the ding was scoped as a *missed-bottleneck alarm*, not a *state-changed notification*) but wrong in practice, because it assumes you can see the butler's posture and MF is frequently not on screen.

- Blocked now chimes at the **5s dwell crossing** — the same poll it enters `blockedTargets`, so the cue and the count can never disagree, and a block that self-resolves inside the dwell still makes no sound.
- The **4-minute escalation is gone.** One cue per state change, both signals.
- Blocked is **foreground-gated like Done**, sharing a *single* PowerShell probe per poll rather than one per cue.
- **Rhythm, not pitch:** Done = one soft tone (587 Hz, 90 ms). Blocked = two quick beeps (900 Hz, 70 ms) around 60 ms of silence. The gap is load-bearing — `[console]::beep` is synchronous, so back-to-back calls render as one continuous tone. The old 900-vs-587 single-beep pair had already failed in use.
- Blocked outranks Done when both fire on one poll; Done stays silent that poll.
- `newlyPersistentBlockedTargets` → `newlyBlockedTargets`; `persistentBlockMs`/`DEFAULT_PERSISTENT_BLOCK_MS` removed; `src/doneChime.ts` → `src/fleetChime.ts`.

Rationale and rejected alternatives: **ADR 0007**.

**#93 — the dead capture TTL sweep is wired on.** `sweepExpiredCaptures` had been implemented, tested, and **never once called**. Measured live on the home machine: `%TEMP%\MistrFlowCaptures` held **286 files / 417.6 MB** accumulated over five days — screenshots of whatever was on screen, retained indefinitely and unencrypted. That is a privacy exposure, not merely a disk leak. **Check this machine's `%TEMP%\MistrFlowCaptures` — it has almost certainly been leaking just as long.** The directory was cleared by hand at home; this machine's has not been.

Also added: an `isRetained` predicate seam, and `ENOENT` hardening on the per-entry loop (a file unlinked between `readdir` and `stat` used to abort the whole sweep — unreachable while it never ran, reachable the moment it runs alongside live captures).

**#94/#95/#96 — capture history.** Each verb keeps an in-memory ring of its last ~10 captures, arrow-navigable with Left/Right in the picker, any entry deliverable.

- **A ring per verb, never shared** — a Relay picker never arrows onto a screenshot.
- **Entries are stateful**: a crop mutates the entry in place, so arrowing never destroys work. Each entry keeps its pre-crop original for Esc's two-stage undo.
- **Ring membership is the only TTL exemption**, and it self-expires: the ring is in-memory, so on quit the exemption evaporates and the next sweep reclaims everything.
- **Fresh payload id per delivery** with the path held stable — a *correctness* requirement, not an optimisation. The delivery ledger keys on `(id, injectText, target)`, so re-delivering an entry to a pane it already reached would return the **cached** outcome: the butler reports "Delivered, sir." while `herdr agent send` is never invoked.
- Arrow keys are `globalShortcut` accelerators scoped to the picker's lifetime — the overlay is `focusable: false` and handles no keyboard input at all.

Rationale, and why four documented "keeps no history" refusals were reversed *narrowly*: **ADR 0008**. Note MF still **never watches the clipboard** — passive capture was considered and rejected (password-manager contents in an on-screen preview; Electron has no clipboard-change event on Windows so it would mean a permanent poll loop; Win+V already covers general clipboard history).

## Verification status — what was proven at home, and what wasn't

Verified on the home machine (single 42" 4K display):

- Arrow keys navigate history in the Capture picker.
- **Re-delivering the same entry to the same pane genuinely arrives twice** — the ledger silent-no-op is fixed. This was the highest-risk item in the batch.
- Arrow keys are released on picker close; they behave normally in other apps afterwards.
- The sweep reclaims expired unretained files, **and** a ring-retained capture survived ~21 minutes across roughly three sweep ticks. Both directions confirmed.
- Relay/Capture ring separation — no cross-contamination observed in the slots.
- 583 tests pass; `npm run typecheck` and `npm run build` clean. (Verified independently, not taken from the agent's self-report — see the CI note below.)

**Not verified anywhere yet — worth a pass on this machine:**

- **Slot 1 after arrowing to a cropped image entry.** #96 changed the crop-identity check from the session's initial artifact to `history.currentOriginal()`, i.e. the entry you are standing on. Arrow to an older image, crop it, press slot 1 — that crop should land on the clipboard. An *uncropped* arrowed-to entry should write nothing (it is already on the clipboard).
- **Byte-budget eviction with a genuinely large clipboard image.** Relay's ring is byte-bounded at 64 MB (Capture's is count-bounded at 10).
- Everything interaction-shaped on **this machine's screens and keyboard** — the position chip (`3 / 10`) legibility in particular, since all visual tuning was done on a 42" 4K.

## Open threads (tracker is the source of truth)

- **#85 — visual handoff packets.** `needs-triage`, and **now unblocked** by the history ring. Refined 2026-07-20 with an insight worth reading before grilling it: the ring dissolves the issue's central open question. #85 was written when captures didn't survive their session, which is why accumulation implied a *mode*. With the ring, spacebar is just **marking a selection over state that already exists** — no mode, and reset answers itself. Quicksend survives as a strict extension (nothing marked → digit sends current, byte-identical to today; ≥1 marked → digit sends the package), the same move ADR 0006 §4 made for the jump gesture. Operator scoping: screenshots plus *at most one* text, never multiple texts.
- **#82 / #68 / #65 / #62 / #59** — the standing "verify on a real desktop, **both machines**" set. These are work-machine tasks by definition; they close when both machines pass. #82's chime items are now partly superseded by #91 — the Blocked cue it describes has changed shape entirely, so re-read it against ADR 0007 before testing.
- **#89** — fleet done-badge asserts a stale count while blind and after send-into-done. `ready-for-human`.
- **#73** — slot-1 terminology rename. `needs-triage`, fully specified.
- **#98** — wire Control Room Tier-2 live-stream forwarder into `.sandcastle/main.mts`. `ready-for-agent`.

## Notes for whoever drives the factory next

- **`bmac902/mistr-flow` has NO CI.** `gh pr checks` returns "no checks reported" on every branch, so Control Room's gated merge **always** refuses with `no-checks-configured`. Clearing it needs `{"confirmed":true,"acknowledgeNoChecks":true}` and explicit operator authorization — raise it *before* firing a batch, not once the PR is already sitting in `draft-PR`. Because there is no CI, get an independent test signal yourself: the run record reports `testEvidence.passed: "unknown"`. Check the branch out, run the suite, return the root to `main`. (Done 2026-07-20: RALPH self-reported 583 passing and it verified exactly.)
- **Two MF instances eat each other's captures.** Each instance holds its own in-memory ring and runs its own sweep, so instance B reclaims instance A's retained files. Observed live 2026-07-20 during testing. Blair decided **not** to file it — it only happens while testing, and over-deletion is the safe failure direction (costs a re-press of `Ctrl+Alt+S`; the dangerous direction was the five-day leak #93 fixed). **Recorded here so it is not rediscovered and mistaken for an exemption bug.**
- Batch `20260720T020757Z-3lijch` ran all four issues cleanly in ~27 minutes on `claude-opus-4-8`, exit 0, no failures, no dirty tree. The slicing that made that work: **split on the confidence boundary, not the feature boundary** — the pure ring (#94) was fully provable in the sandbox, the wiring (#95/#96) was provable nowhere but a real desktop, and separating them meant a green PR whose green parts were actually meaningful.
