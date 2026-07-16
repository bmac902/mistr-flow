# Claude Design ↔ code handoff

Mistr Flow's butler (the mascot) is designed in **Claude Design** and lives in
`public/overlay.html`. That same file also holds functional DOM the code drives
(the capture-preview panel, the picker list, the card). Because two owners edit
one file, exports drift from the code and every integration turns into a manual
reconciliation. This is the process that stops that.

## Who owns what

`public/overlay.html` is **co-owned**:

- **Claude Design owns the butler** — the `<svg id="mascot">` markup, every
  `.mf-state-*` mascot rule, the `@keyframes mf-*`, and the mascot's status/copy
  lines. Integrated **verbatim** from the export.
- **Code owns everything else** — the card structure, the capture-preview panel
  (`#capture-preview` and friends), the picker entries, and anything the renderer
  reaches by id.

`public/overlay-renderer.js` is **code-only**. Claude Design bundles a copy in its
export; it is always older than the repo (no click-to-jump, no capture preview).
**Discard it.** Never integrate the export's renderer.

## The round-trip

1. **Seed from the live file.** Before opening Claude Design, run:

   ```
   npm run design:canvas
   ```

   It snapshots the *current* `public/overlay.html` into `design-canvas/overlay.html`.
   Load **that** into Claude Design as the starting canvas — never an old
   storyboard. Because design now edits on top of the current code, its export is
   a superset (it already contains the capture-preview panel, the current card
   DOM, everything), and drops back in with no hand-splicing. This one step is the
   whole fix.

2. **Edit only the butler** in Claude Design. Leave the functional DOM alone.

3. **Re-export** and drop the file onto `public/overlay.html`.

4. **Check before you trust it:**

   ```
   npm run design:check
   ```

   It derives the renderer's DOM contract (every `getElementById` in
   `overlay-renderer.js`) and fails loudly, naming any hook the export dropped.
   If it passes, the export is safe. If it fails, the export was authored from a
   stale canvas — re-seed with `design:canvas` and re-export, or re-graft the named
   element(s) verbatim from git before integrating.

5. **Integrate the butler verbatim.** Never hand-author or "fix" a keyframe — if
   the *timing* or *behavior* is wrong, that fix goes in the wiring (`main.ts`),
   never in the animation. (The #41 lesson: a finger-wag that ran too long was a
   timing bug in `main.ts`, not an animation bug — editing the export's keyframe
   was the wrong move and wasted the designer's work.)

## Keep the phase vocabulary in sync

The renderer applies `mf-state-<phase>` from `OverlaySnapshot.phase`. So the
`.mf-state-*` class names in the design **must** match the `OverlayPhase` union in
`src/overlay.ts`. When design renames a state (e.g. `fleet-1` → `fleet-1-blocked`),
that rename ripples into `src/overlay.ts` (the union, the copy maps, the
tier→phase map) and the state→copy tests. That's expected code-side work — it's
wiring, not fighting the design.

## Tools

- `npm run design:canvas` — snapshot the live overlay as the Claude Design starting canvas (gitignored output).
- `npm run design:check [file]` — verify an overlay.html satisfies the renderer's DOM contract; non-zero exit on any missing hook.
