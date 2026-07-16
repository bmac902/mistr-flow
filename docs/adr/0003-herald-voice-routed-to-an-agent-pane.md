# Herald — voice routed to an agent pane, on its own hotkey

Status: accepted (2026-07-16)

Dictation pastes into whatever window is focused, but 75–90% of Blair's real traffic goes to a live Herdr agent pane (the same evidence that drove Capture and Relay). So Mistr Flow's oldest, fastest sense — voice — is the one that could not reach its dominant destination: to get spoken text into an agent today you dictate somewhere, then copy, then Relay. **Herald** closes that: a dictated utterance is Polished and routed straight to a pane. It shares three letters with Herdr, and the butler *heralds* your spoken words to the agent.

Herald is not new plumbing. The send seam already exists — `runSendSession` routes a `SendPayload` through the picker to a pane, and both Capture and Relay feed it. Dictation already produces text; text is a `SendPayload`. Herald is voice's front half (record → Polish) joined to Relay's back half (picker → deliver).

## Decisions

1. **Herald is a separate verb on `Ctrl+Alt+H`; `Ctrl+Alt+D` is untouched.** Dictation-to-paste stays the instant, no-picker, sub-second action it is today — that muscle memory is used 100–200×/day and is sacred. Rejected: a modifier on the dictation hotkey (`Shift+D`) — easy to fumble mid-thought; and a single hotkey that always ends in a picker — that taxes every local paste with a pick step. A clean second hotkey keeps both paths fast and they can never collide. `H` ("Herdr") sits beside `D` (dictate) and `C` (clipboard) in the existing `Ctrl+Alt+` family.

2. **Polish always runs; there is no raw-transcript mode.** A clean instruction is exactly what an agent parses best — arguably more so than a Teams message — and the vocabulary config guards the technical terms Polish might otherwise mangle. The latency is identical to the dictation Blair already accepts. A raw-and-instant path for short follow-ups ("approve", "run the build") was considered and deferred: not built unless usage proves it's reached for.

3. **Read-and-pick: the Polished transcript shows in the picker's read-only preview, and choosing a target is the confirm-and-send.** Voice is the only input with *no visual record* — you never see what Whisper heard — so a mis-hearing is about to reach a live agent. The preview (reusing Relay's text-preview slot) is the exact defense Capture's preview was built for, sharper here. No separate confirm beat: choosing a destination is already an intentional act, so a second confirmation would add friction without adding safety. If the transcript is wrong, Esc re-dictates. Rejected for v1: a blind-send-to-trusted-pane mode, and in-overlay editing of the transcript (that turns the overlay into a text editor and slows a flow that must stay fast).

4. **Picker slot 1 = "paste here" salvage; panes on 2–9.** Slot 1 delivers the polished text into the focused window — exactly what `Ctrl+Alt+D` would have done. Two payoffs: it keeps "digit 2 is always the same pane" true across Capture, Relay, and Herald; and it is a salvage path — fire `H` when you meant `D`, and since you've already spoken, tap `1` rather than re-dictate. It also means Herald degrades gracefully: with Herdr down or no eligible panes, the picker still offers slot 1, so the dictation is never lost.

5. **No new Claude Design art.** Herald is a composition of beats already designed and shipped: dictation's `listening` / `recording` / `polishing`, then the send session's `capture-picker` / `capture-delivering` / `capture-delivered`. Consequence: Herald ships as pure code, with no Claude Design round-trip.

**Governing principle:** voice never sends silently. Even a future repeat-last-target or trusted-pane shortcut (see #46) must still flash the transcript before it lands — the no-visual-record risk does not go away when the pick is skipped.

## Consequences

- **New code is mostly wiring.** A `Ctrl+Alt+H` handler runs dictation's record → transcribe → Polish, wraps the polished text as a text `SendPayload`, and hands it to `runSendSession` with slot 1 bound to paste-here. It reuses the picker, the transcript preview, `focusOnDeliver`, the delivery ledger, bracketed-paste, and transcribe/Polish (through the AI-provider seam), plus the verb-lock arbiter, which already contemplates a third routed verb.
- **`Ctrl+Alt+H` registration fails loudly on an OS-wide collision**, surfaced like the other hotkeys — never silently swapped.
- **No config flag.** Herald is additive and always available, unlike `focusOnDeliver`, which changes existing behavior and therefore opts in.
- **v1 boundaries, all revisitable:** read-only preview (no editing), no blind-send, no raw mode, single target per utterance (no broadcast).
