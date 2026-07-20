# Capture history is a bounded in-memory ring, one per verb

Status: accepted (2026-07-19)

Amends the "keeps no history" refusals in `CONTEXT.md` (Relay, and the no-archive line) and narrows ADR-era "nothing is TTL-exempt". Issues #93, #94, #95, #96.

Mistr Flow captures are one-shot: press `Ctrl+Alt+S` and the previous screenshot is unreachable, because every part of a capture session is a local variable in `runSendSession` that becomes garbage when the promise settles. The operator wants to arrow left/right through recent captures in the preview pane and deliver any of them — the goal being to route more daily work through Mistr Flow rather than around it.

This runs against a boundary the codebase states four times: *"fire-and-forget, nothing persisted beyond config"*; Relay *"never watches, polls, or logs the clipboard, and keeps no history"*; *"no archive, no clipboard history"*; *"No Save verb in v1"*. Those refusals are reversed **narrowly and deliberately**, not abandoned.

A live measurement taken while designing this changed its shape. `sweepExpiredCaptures` has been implemented, tested, and **never called** — `%TEMP%\MistrFlowCaptures` held 286 files / 417.6 MB accumulated over five days. Not merely a disk leak: those are screenshots of whatever was on screen, retained indefinitely and unencrypted. Fixing that became the first slice, and the design below is shaped around not making it worse.

## Decisions

1. **The history is a bounded in-memory ring, one per verb.** Bounded by entry count (10) *and* by cumulative bytes, because clipboard images run to tens of MB and a count-only cap would let ten of them balloon memory. Nothing is written to disk that is not written today. This reverses "keeps no history" for a bounded in-process ring while leaving *"No Save verb"* fully intact — there is still no archive, nothing survives quitting, and no new file is created by remembering something. Rejected: persisting the ring to `%APPDATA%`, which would need a real store, pruning, and handling entries whose PNG has been swept — a much larger break for a feature whose value is mostly within a working session.

2. **Only what passes through a verb enters the ring — Mistr Flow still never watches the clipboard.** Passive clipboard capture was seriously considered and rejected on three grounds: it would capture password-manager contents and render them in the preview pane, making it mandatory to honour Windows' `ExcludeClipboardContentFromMonitorProcessing` / `CanIncludeInClipboardHistory` conventions — which Electron may not even surface, a risk this codebase has already been bitten by once (`readBuffer("CF_HDROP")` silently returning empty, forcing the PowerShell shell-out); Electron has no clipboard-change event on Windows, so it would mean a permanent poll loop; and Windows already ships Win+V for general clipboard history. The distinctive thing Mistr Flow can offer is a ring of *re-deliverable captures*, not a clipboard manager. The Relay "never watches, polls, or logs" clause therefore **stands unamended** — only "keeps no history" moves.

3. **A ring per verb, never one shared ring.** A Relay picker must never arrow onto a screenshot, nor a Capture picker onto a block of text. Rejected: one interleaved ring — fewer concepts, but it makes arrowing type-unstable in a pane that shows one thing at a time.

4. **Entries are stateful: a crop mutates the entry in place.** Arrowing is pure navigation and never destroys work, so cropping an entry, arrowing away, and arrowing back returns the crop. Each entry retains its pre-crop original, because Esc's two-stage undo needs a target. Rejected: immutable entries, where arrowing away silently discards a crop just made; and crop-pushes-a-new-entry, which matches how the code already treats a crop as a genuinely fresh capture but spends a ring slot on every crop iteration, filling the ring with intermediates.

5. **Ring membership exempts a file from the TTL sweep — and that is the *only* exemption.** This narrows "nothing is TTL-exempt" rather than discarding it: retention is bounded by the ring, the ring is bounded twice over, and because the ring is in-memory the exemption evaporates when the app quits, so the next sweep reclaims everything. There is no persistent exemption bookkeeping and no way for a file to be retained by something the operator cannot see. Rejected: no exemption with a raised TTL (a wall-clock rule that deletes entries while the ring still shows them); no exemption at 15 minutes (reduces the feature to a scratch buffer).

6. **A fresh payload id is minted per delivery, with the file path held stable.** Not an optimisation — a correctness requirement. The delivery ledger keys idempotency on `(payload id, injectText, target)`, so re-delivering a history entry to a pane it already reached would return the *cached* outcome: the butler reports "Delivered, sir." and `herdr agent send` is never invoked. A silent no-op is the worst failure available here. This is the trick the crop path already uses and documents.

7. **Arrow keys are `globalShortcut` accelerators scoped to the picker's lifetime.** Not a renderer key handler, because the overlay is `focusable: false` and handles no keyboard input at all — every picker key is already a global accelerator from the main process. Navigation enters through a fifth injected source in the shape of the existing `CropSource` / `AgainSource` / `RowClickSource` / `CancelSource`, which is also what makes it testable without a keyboard. The accelerators must be released on every close path; a leaked arrow-key grab is felt system-wide.

## Consequences

- **The leak fix ships first and independently** (#93), carrying a retention-predicate seam that defaults to retaining nothing, so the sweep can be switched on before any history exists.
- **The pure ring is a separate slice from its wiring** (#94 vs #95/#96). The split follows the confidence boundary, not the feature boundary: the ring is fully provable in a sandbox, while `globalShortcut` firing, preview repainting, and indicator legibility are provable nowhere except a real Windows desktop. Bundling them would produce one change where half is verified and half is a guess, with no way to tell which half broke.
- **Relay is not a copy-paste of Capture** (#96): heterogeneous preview shapes (thumbnail vs text summary), four payload kinds to round-trip, and slot 1's crop-identity check needing to compare against the entry currently under the cursor rather than one captured at session start. The shared plumbing is hoisted, not forked.
- **Memory grows with use within a session**, bounded by the byte budget. Relay is the verb that will actually exercise byte-based eviction.
- **Unchanged**: no clipboard watching; no on-disk archive; no Save verb; nothing survives a quit; the standing boundary that Mistr Flow learns no git/session/issue semantics.
