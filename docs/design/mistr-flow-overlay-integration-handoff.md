# Mistr Flow Overlay Design Integration Handoff

## Goal

Integrate the committed Mistr Flow motion/design storyboard into the actual app overlay so the running Windows utility starts to feel like Mistr Flow, not a generic debug bar.

This is the immediate payoff slice: make the tiny top-hat gentleman visible in the product.

## Source design reference

- Spec: `docs/design/mistr-flow-motion-storyboard.md`
- Interactive board: `docs/design/assets/mistr-flow-storyboard.html`
- Board captures:
  - `docs/design/assets/mistr-flow-board-character.png`
  - `docs/design/assets/mistr-flow-board-states-1.png`
  - `docs/design/assets/mistr-flow-board-states-2.png`
  - `docs/design/assets/mistr-flow-icon-concepts.png`

## Product principle

The joke makes the tool lovable, but it must never slow the user down.

The mascot is delightful seasoning, not the meal. Animations must be fast, subtle, and never steal focus.

## Current implementation context

The repo already has a working Electron shell and overlay primitives:

- `src/main.ts`
  - creates the always-on-top transparent overlay window
  - registers the global hotkey
  - sends `overlay-state` snapshots to the renderer
- `public/overlay.html`
  - currently renders a plain dark pill/debug bar
- `public/overlay-renderer.js`
  - currently displays `🎩 ${snapshot.mascotCopy}` and toggles simple error/done/cancelled classes
- `src/overlay.ts`
  - defines `OverlayPhase`
  - builds `OverlaySnapshot`
  - currently uses placeholder/internal copy such as `recording`, `processing`, `done`

## Desired outcome

Replace the generic debug overlay with a small Mistr Flow status card:

- cream card, warm border, soft shadow
- tiny top-hat/moustache gentleman avatar
- status text from the design spec
- subtle per-state styling/animation hooks
- click-through / no focus stealing behavior preserved
- right-click context menu behavior preserved
- reduced-motion support included

The first implementation does **not** need perfect mascot animation. It should establish the real visual identity and state mapping.

## State copy from the design spec

Use these exact status strings:

- `idle`: `Ready when you are, sir.`
- `listening`: `Listening…`
- `recording`: `Go on, I’m taking notes…`
- `processing`: `Tidying your ramble…`
- `polishing`: `Ahem. Much better…`
- `done`: `Pasted, sir.`
- `error`: `Mistr Flo tripped over the microphone.`
- `cancelled`: `Very well. We shall pretend that never happened.`

Suggested internal mascot/action labels:

- `idle`: `hat + eyes`
- `listening`: `tips top hat`
- `recording`: `moustache wiggle`
- `processing`: `cane twirl`
- `polishing`: `brushes sentence ribbon`
- `done`: `top hat bow`
- `error`: `top hat askew`
- `cancelled`: `exits stage left`

## Visual tokens

From the storyboard:

- Cream/card: `#F8F1E1`
- Stage/ink: `#221D19` / `#2A241F`
- Warm charcoal: `#6B5E4C`
- Brass: `#B8893C`
- Light brass: `#D8B068`
- Border: `#E0D4BC`
- Success: `#1F8A5B`

Overlay target:

- about `280px × 56px`
- `12px` radius
- warm cream surface
- 1px warm border
- soft shadow
- mini avatar at left
- status text center/left
- optional small state indicator at right

## Suggested implementation slices

### Slice 1 — snapshot copy contract

Agent-testable.

- Add `statusCopy` to `OverlaySnapshot` in `src/overlay.ts`.
- Update `buildOverlaySnapshot` and `buildErrorOverlaySnapshot` to emit the exact design copy above.
- Update overlay tests to pin the state → copy mapping.

### Slice 2 — renderer markup and CSS identity

Agent-testable with DOM/static checks if practical.

- Replace the plain dark pill in `public/overlay.html` with a Mistr Flow card structure.
- Build the tiny mascot using simple DOM/CSS shapes or inline SVG.
- Update `public/overlay-renderer.js` to render `snapshot.statusCopy` and set `data-phase`.
- Preserve right-click context menu wiring.
- Do not introduce remote dependencies.

### Slice 3 — motion hooks and reduced motion

Mostly agent-testable, human-verified visually.

- Add phase classes/data attributes for:
  - `listening`: hat tip/lean
  - `recording`: moustache/wave loop
  - `processing`: cane twirl hint
  - `polishing`: sentence brush hint
  - `done`: success/bow hint
  - `error`: hat askew
  - `cancelled`: stage-left fade
- Add `@media (prefers-reduced-motion: reduce)` that disables twirl/wiggle/bow/hat-fall and uses quick cross-fades only.

### Slice 4 — human Windows verification

Do **not** mark this as `ready-for-agent` for Sandcastle.

Manual acceptance:

- Start app on Windows.
- Press hotkey.
- Confirm overlay appears with Mistr Flow visual identity.
- Confirm it never steals focus.
- Confirm right-click context menu still works.
- Confirm state transitions feel charming, not slow.
- Confirm reduced-motion behavior if Windows/browser setting is available.

## Sandcastle caveat

Sandcastle agents run in a headless Docker sandbox. Do not require live Electron GUI, global hotkey behavior, actual Windows paste, or manual overlay feel as ready-for-agent acceptance criteria.

Ready-for-agent issues should stick to:

- state/copy contracts
- DOM/CSS/static files
- tests/typecheck/build
- reduced-motion rules existing
- renderer code preserving IPC/context-menu seams

Put live GUI feel checks in a separate ready-for-human/manual verification issue.

## Non-goals for this integration

- Do not redesign the whole app architecture.
- Do not add a tray icon yet unless it is explicitly scoped.
- Do not add packaging/installer work.
- Do not add a full design system framework.
- Do not introduce React unless there is a strong reason.
- Do not slow the dictation loop for mascot theatrics.

## Suggested GitHub issue title

`Integrate Mistr Flow storyboard into the live overlay UI`

## Suggested acceptance criteria

- `OverlaySnapshot` exposes exact design status copy for every phase.
- `public/overlay.html` renders a Mistr Flow card instead of the generic dark debug pill.
- Renderer applies `data-phase` or equivalent state hooks for every overlay phase.
- The overlay includes a top-hat/moustache mascot representation.
- Reduced-motion CSS disables decorative motion while preserving speed.
- Existing tests pass: `npm test`.
- Typecheck passes: `npm run typecheck`.
- Production behavior remains focused: overlay is non-focus-stealing and context menu IPC remains wired.
