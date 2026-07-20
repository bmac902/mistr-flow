## Latest session handoff

**`docs/handoff/2026-07-20-work-laptop-fleet-chimes-and-capture-history.md`** — read this first. It states what to pick up next on the **work laptop** and leads with the trap that silently breaks the sync: this repo has **two remotes**, and every commit from the 2026-07-19/20 session went to `origin` (`bmac902/mistr-flow`) only — never to `blairfork` (`Blair-MacDonald_questsw/mistr-flow`). Check `git remote -v` *before* pulling, or the pull returns nothing and looks like it worked.

It also covers what shipped (#91 fleet chimes standardised — Blocked now chimes at the 5s dwell instead of 4 minutes, rhythm-distinguished from Done; #93 the never-called TTL sweep wired on after 417 MB of screenshots accumulated over five days; #94–#96 capture history — an in-memory ring per verb, arrow-navigable in the picker), the **config trap** (`persistentBlockDing: false` still silences the new blocked chime, so an old config makes #91 look broken), what was and was not verified at home, and the open threads (#85 now unblocked and refined, #82/#68/#65/#62/#59 both-machine verification, #89, #73, #98).

Earlier handoffs remain useful for context: `2026-07-17-…` (Project Anchors setup, still the per-machine config task), `2026-07-18-…` (CRLF/EOL recovery).

Most handoffs in `docs/handoff/` are machine-local (excluded via `.git/info/exclude`, which does not travel), so on a fresh clone that folder looks empty. The ones named above are **force-added and tracked** on purpose, so they survive a `git pull` on another machine. If you write a handoff that a *different machine* needs, `git add -f` it — otherwise it silently never leaves the machine that wrote it.

## Running Mistr Flow on a fresh machine

- `npm start` (= `npm run build && electron .`). **`dist/` is gitignored**, so a fresh clone has no build until this runs.
- The desktop shortcut (`npm run install:shortcut`) is pinned to the folder it was created from — cloning to a *new* folder does **not** repoint an existing shortcut. Re-run `install:shortcut` in the new folder, or launch with `npm start`.
- Config is **per-machine** at `%APPDATA%\MistrFlow\config.json` and is **not** in the repo. A new machine starts with none of your flags. Notably `focusOnDeliver` defaults to `false`, so focus-after-delivery does nothing until you set `"focusOnDeliver": true` there.
- Capture/focus behaviour has **no visible UI change** — do not expect the app to look different. The difference is what happens after delivery.

## Agent skills

### Issue tracker

Issues and PRDs live on GitHub (`bmac902/mistr-flow`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) — no remapping. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.

### Claude Design assets

The butler mascot in `public/overlay.html` is designed in Claude Design and
integrated **verbatim** — never hand-edit a keyframe (timing/behavior fixes go in
`main.ts`). Before a design session run `npm run design:canvas` to hand Claude
Design the *live* file as its canvas; after an export run `npm run design:check`
to catch a stale export before it breaks anything. Full round-trip in
`docs/agents/claude-design-handoff.md`.
