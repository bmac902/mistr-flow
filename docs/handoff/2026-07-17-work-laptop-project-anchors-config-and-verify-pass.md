# Handoff → work laptop, 2026-07-17: configure Project Anchors, run the verify pass

**Tracked on purpose** (`git add -f`, same as the 2026-07-16 Azure handoff) so it survives the pull to the work machine. Written for the agent that boots there tomorrow.

## Start here, in order

1. **`git pull`** — brings ~15 commits from the 2026-07-16 evening session (done-awareness, project anchors, verb switch, and more; see "What shipped" below).
2. **`npm install`** — non-negotiable: the home machine's `node_modules` was silently stale against the `^0.12.0` sandcastle pin and would have instant-killed a batch. Assume this machine drifted too.
3. **`npm run build`**, then restart Mistr Flow (`npm start`, or re-run `install:shortcut` if the folder moved).
4. **Configure this machine's Project Anchors** — the main setup task. See next section.
5. Then the verification pass and open threads below.

## Project Anchors — per-machine config (the core task)

The picker rows now speak a three-channel grammar (CONTEXT.md glossary: *Project Anchor*): **keycap color = agent** (claude orange / copilot blue / hermes gold / codex slate / unknown brass), **glyph = project**, **text = friendly name · status-colored word**. The glyph SVG *library* ships in `public/overlay-renderer.js` (`PROJECT_GLYPHS`: `tophat`, `note`, `terminal`, `wing`, `flask`) — the pull brings it. The cwd→project **mapping is per-machine config, deliberately never source**.

Edit `%APPDATA%\MistrFlow\config.json` **surgically** (it holds an API key and per-machine flags — preserve everything, add one key):

```json
"projectAnchors": [
  { "prefix": "C:\\path\\to\\some-project", "name": "Friendly Name", "glyph": "terminal" }
]
```

Rules (validated in `src/projectAnchors.ts`, tested): longest prefix wins, case-insensitive, path-boundary-aware (`\dev\mistr` never claims `\dev\mistr-flow`), forward/back slashes both fine. Unmapped cwds fall back to basename — never an error.

How to build the list for THIS machine: `ls` the dev root(s) + check live pane cwds via `herdr pane list`. Map what actually runs agents; skip the rest. Home machine's set, as a reference shape: mistr-flow→tophat, soundcloud-discovery→note, soundcloud-cli→note, coding-agent-observer→terminal, agent-memory-service→terminal, scratch→flask.

**New glyph needed?** Draw it — a small stroke-based SVG added to `PROJECT_GLYPHS` (16×16 viewBox, `stroke-width` rides the shared CSS, warm-ink `currentColor`). Hand-drawn only: never stock emoji, never product logos (house rule, recorded in CONTEXT.md). Commit it so it travels back home.

**Still missing**: the Hermes repo's path (not under `C:\dev` at home — Blair works out of a Scratch folder inside it). If this machine knows where Hermes lives, add `…\hermes → wing` and `…\hermes\scratch → flask` (nested anchors coexist; longest wins) — and tell Blair it's done.

## Verification pass on this machine (issue #82 + tonight's UI)

- **#82's work-machine items**: done-chime fires when an agent finishes while Herdr's window isn't foreground (test with *multiple terminal windows open* — the gate is the precise minted-title check, not a process-name guess); no chime when watching Herdr; `Ctrl+Alt+J` falls through to done panes when nothing's blocked; badge legibility. Comment results on #82; it closes when both machines pass.
- **Tonight's UI on this machine's screens**: butler 25% scale, 350px stage, 318×179 crop preview, glyph/keycap/status-color rows, gold badge. All were tuned on a 42" 4K — a work monitor may want different numbers. They're single constants: scale in `overlay-renderer.js` (TV-scale block), window in `main.ts` `winWidth`, preview in `captureThumbnail.ts`.
- **Hotkeys changed**: Capture is now `Ctrl+Alt+S` (family: D dictate, C relay, H herald, J jump). Numpad digits work in pickers.

## Open threads (tracker is the source of truth)

- **#73** — slot-1 terminology rename, agent-ready, fully specified. Fire via factory batch or pane launch when convenient.
- **#82** — the verify pass above.
- **Verb switch H-quirk** (commit `2e0f82f` message documents it): rapid hammering on H can toggle/restart the fresh herald recording. A "smarter" guard variant made it worse and was reverted — do NOT re-add token-supersession blindly; reproduce first.
- **Intermittent `helper-error` captures** ("The capture helper stumbled") — seen twice at home, never root-caused; it self-resolved. If it recurs: the standalone helper works (`powershell -NoProfile -File scripts/capture-active-window.ps1 -OutDir <tmp>`), so capture the failing context.
- **Live-debug loop for interaction bugs** (home-machine memory won't travel, so recorded here): kill electron by exact `ExecutablePath` + `Start-Process` relaunch with `-RedirectStandardOutput <file>` makes main-process logs readable; `(New-Object -ComObject WScript.Shell).SendKeys('^%c')` fires real global hotkeys; temp `console.log` in refuse/decision paths + rebuild = evidence in seconds. Strip diagnostics before commit.

## Where the design lives (don't re-derive)

- CONTEXT.md — glossary (*Done*, *Project Anchor*, corrected *Eligible Target*) + the decision trail for everything above, all dated 2026-07-16/17.
- `docs/adr/0006` — done-awareness alert grammar. PRD #77 — the feature spec. ADR amendments in 0004/0005.
- Commits `5fcc677..c0ddc7e` — each message carries its own rationale.

## Suggested skills

- `/sandcastle-preflight` — before any batch here; the version-drift check exists because of this exact machine-to-machine gap.
- `/run-the-factory` — blank directive first for a board summary; then fire #73 if the board agrees.
- `/side-monitor` — if watching a launched pane.
- `/handoff` — end of session, `git add -f` if the other machine needs it; update CLAUDE.md's pointer.
