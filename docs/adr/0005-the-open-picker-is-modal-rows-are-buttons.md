# The open picker is modal — rows are buttons, the butler is the handle

Status: accepted (2026-07-16)

The picker's numbered rows are styled like buttons, and the instinct is to click them — but they only answer to digit keys ("they come up, and they look like buttons, and you can't click them" — the #47 pain, verbatim). The original plan was to arbitrate click-vs-drag on the rows with the same threshold gesture the resting bar uses. Living with the shipped picker killed that plan: **by the time the picker is open you are in "choose a destination" mode, not "reposition the window" mode.** The right move is not to adjudicate the ambiguity but to remove it.

## Decisions

1. **Full parity: every key-cap row clicks.** Digits 2–9, slot 1 where present (Capture's Clipboard, Herald's Paste-here; Relay renders none), and the ⟲ again-row (ADR 0004 deferred its clickability here). An unmarked again-row clicks as the same truthful no-op its key produces. Rejected: panes-only clickability — three row kinds styled identically as buttons where only some button doesn't fix the lie, it shrinks it.

2. **A mouse click is another way to press the row's key — never a second implementation.** A click dispatches the *exact same selection event* through the picker handle's one-selection-at-a-time channel and flows down the identical delivery path — ledger, idempotent unknown→retry, bracketed paste, slot-1 semantics, again-resolution all inherited, not re-implemented. Mechanically this is the established injected-source shape (crops and again-confirms already arrive this way), and a stale click after close is dropped by the same instance binding.

3. **While the picker is open, the window is modal and pointer roles are fixed:** rows are pure buttons (they no longer participate in the window-drag gesture at all); the preview panel keeps its crop-drag; window drag is confined to the butler/header, which becomes *purely a window handle* — the resting bar's click-to-jump (jump-to-longest-blocked, #52) is **suppressed while a picker is open** and restored the moment it closes. A mid-pick jump would yank OS focus to some blocked pane in the middle of choosing a destination — exactly the ambiguity this ADR exists to remove. Rejected: threshold-based click-vs-drag arbitration on the rows (reusing `clickDragGesture`) — it solves a conflict the modal framing shows shouldn't exist, and "this was almost a click but became a drag" is a worse contract than "rows are buttons, the butler is the handle." (Suppression is deliberately scoped to picker-open, not every mid-flight verb — the resting bar outside a picker keeps today's behavior.)

4. **Rows get real button affordances** — pointer cursor, hover, pressed state — with all styling **renderer-owned** (`overlay-renderer.js`, same discipline as the again-row's unmark styling). `public/overlay.html` is a Claude Design asset and is not touched; entries are pointer-interactive only while a picker is open, and the overlay's mouse-passthrough returns to normal on close.

**Governing rule:** one input grammar — keyboard stays the fast path, the mouse is an equal way to say the same thing, and no pointer gesture in the picker can mean two things.

## Consequences

- **No new delivery machinery.** The work is a renderer click surface + an injected click source into the existing selection channel + a pure gate for bar-click routing (jump vs. suppressed). Keyboard behavior is byte-identical.
- **Drag behavior changes visibly during pickers**: grabbing a row no longer moves the window — the butler/header does. Outside a picker, nothing changes.
- **The #52 jump-click gains a modal gate** it previously lacked; its resting-bar behavior is untouched.
- **v1 boundaries, revisitable:** no double-click semantics, no right-click menus on rows, no drag-to-reorder — rows are buttons, nothing more.
