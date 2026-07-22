# Paste a capture into the focused app — `Ctrl+Alt+V`

Status: accepted (2026-07-22)

Extends the verb model. Builds on the capture-history ring (ADR 0008, #93–#96) and the app-delivery paste primitive with its injectable focus-settle (#99). Issue #101.

Every verb so far carries a Mistr Flow payload *outward* — to an agent's pane (Capture, Relay, Herald) or, via slot 1, to the clipboard for the operator to place by hand. Getting a screenshot into a human's chat app (Teams, Slack) still meant the old dance: open the picker, hit `1` to copy, Alt-Tab to the app, `Ctrl+V`. `Ctrl+Alt+V` collapses that into one keypress — it puts the current capture on the clipboard and fires `Ctrl+V` into whatever window has focus.

This is the **human-app counterpart to Herdr-pane delivery**. Pane delivery injects a file *path* into an agent's PTY and the agent `Read`s it; `Ctrl+Alt+V` pastes the *content* — a bitmap or text — into a human's composer. The two are duals, and the boundary between them is a property, not a gap (decision 6).

## Decisions

1. **The foreground window is a delivery target, `kind:"foreground"`, routed through the existing app adapter — app delivery *minus* the focus step.** `Ctrl+Alt+V` is precisely Herald's "Paste here" un-aimed: the app you were in still holds focus (the overlay is `focusable:false`, so the global hotkey never moved OS foreground), so there is no window to focus first — write the clipboard, settle, paste. Modelling it as a new `kind` in `createRoutingDeliveryAdapter` (rather than a parallel primitive) reuses the app adapter's idempotency ledger and its image-vs-text flavor logic verbatim. Rejected: a bespoke paste path — it would duplicate the ledger and flavor recovery, the two things most likely to drift and the two the #95 trap punishes.

2. **The clipboard content follows the payload flavor, generalizing "paste here" beyond text.** Herald's slot-1 paste only ever writes text; the capture ring holds screenshots. So the foreground path writes a bitmap for an image payload, a spill file's *contents* for a `.txt`, and the inline text otherwise — the same `writeClipboardForPayload` step the app path runs, now shared.

3. **Two entry points, one mechanism.** (a) **Bare hotkey, no picker open** → paste the *newest* Capture-ring entry; this is the "screenshot → paste in Teams" flow. (b) **Inside an open picker** → paste the currently-arrowed entry, so the operator can arrow to an older capture and paste *that*. The bare path reads `captureHistory.newest` (a new ring accessor — "the last screenshot," never wherever a prior picker left the cursor); the in-picker path pastes the session's current (arrowed, possibly cropped) artifact through a sixth injected picker source beside `CropSource`/`AgainSource`/`RowClickSource`/`CancelSource`/`HistorySource`. Like the again/cancel sources it is a pure emit — the `Ctrl+Alt+V` accelerator stays a standalone `globalShortcut` in `main.ts` and is routed into the open picker exactly as the again-confirm routes the verb's own key, so the handle registers no accelerator of its own.

4. **A local outcome, like slot 1 — it never updates the shared Last Target.** "The agent I'm working with right now" is a pane, never the foreground window, so a foreground paste must not become the again-target for the next Capture/Relay/Herald. This is the one delivery that *does* reach `deliver` (it needs the ledger) yet must not record, so `withLastTargetRecording` skips a `kind:"foreground"` target — the same "slot 1 is the local outcome" rule (CONTEXT.md), enforced at the one seam a foreground delivery passes through. In the picker it settles on the success beat ("Pasted, sir."), never the cancelled beat.

5. **A fresh payload id is minted per paste — correctness, not optimisation.** The ledger keys on `(id, injectText, target)`, so re-pasting a ring entry with a reused id would return the *cached* "Delivered, sir." while no `Ctrl+V` ever fires — the exact #95 trap the ring already guards for pane delivery, now guarded for foreground paste too. The regression is asserted at the adapter (two fresh ids paste twice; a reused id caches once).

6. **The image-vs-text destination boundary is a documented property, not a bug to solve here.** A bitmap `Ctrl+V` can't land in a terminal or a plain-text field; that destination is the Herdr-pane path (inject a path the agent can `Read`). `Ctrl+Alt+V` is deliberately for human apps whose composers accept a pasted image.

7. **An empty Capture ring is a truthful mascot refusal, never a faked success.** Bare `Ctrl+Alt+V` with nothing captured shows "Nothing captured yet, sir." — the paste twin of Relay's "nothing to send," per the personality-is-a-property rule. Never a silent no-op, never a "Pasted, sir." over an empty clipboard.

8. **A small focus-settle before the paste, kept short and separate from the shared 50 ms.** Reusing #99's injectable `delay` seam keeps the app-delivery and foreground paths structurally identical (`writeClipboard → delay → paste`). The foreground settle is much shorter than the app path's 150 ms — the foreground window already holds focus, so there is no webview window-focus → composer-focus gap to wait out, only cheap insurance against a clipboard-write → paste race. The 50 ms already baked into `simulatePasteKeystroke` is untouched (a scope line of #101).

## Consequences

- **No new config surface.** The target is always "current foreground," never a configured app — a configured-app target is `appTargets`/`appDeliver`, which already exists. There is no per-app matcher, delay, or focus-keys for the foreground path.
- **Mistr Flow still never watches the clipboard** — this verb reads its own ring on demand (Relay's "never watches, polls, or logs" clause is unamended, ADR 0008 decision 2).
- **The sandbox proves the mechanism; the host proves the payload.** The adapter ordering (clipboard → settle → paste, no focus), the ledger, the fresh-id guard, the empty-ring refusal, and the local-outcome/Last-Target rule are all provable against the log-array fakes. Whether a bitmap actually lands in Teams/Slack, and whether foreground stayed put, are provable nowhere but a real Windows desktop — reported outstanding for host verification, never faked.
- **Herald's picker gains the verb too** (it shares the Capture picker build): `Ctrl+Alt+V` there pastes the transcript into the focused window — the same local ending as its slot-1 "Paste here," reached by the paste key rather than the digit. Redundant, but consistent and non-silent.
- **Unchanged**: the shared `simulatePasteKeystroke` 50 ms; dictation, Herald "paste here", and app-delivery behaviour byte-identical; no clipboard watching; no on-disk archive; no Save verb; nothing survives a quit.
