# Handoff — "Capture" capability seeded → next: grill it, then epic + issues — 2026-07-14

## Start here (next session)
Blair wants to add a **Capture verb** to Mistr Flow: global hotkey → **active-window screenshot**
→ tiny picker overlay → routed action. Your job is to **run a grill session** (`/grilling` or
`/grill-with-docs`) to pin the scope, then produce an epic + curated issues (Blair's standard
flow: grill → PRD/epic → issues → agent batch). Nothing has been built or filed yet — this
doc is the only artifact; the design below is the agreed starting position, not a spec.

## The idea in one breath
Kill screenshot/copy-paste friction. Key insight (from a ChatGPT chat Blair had, sharpened
with Claude): *"I need it invokable everywhere, not capturing everything."* Mistr Flow already
is a capture daemon — for audio (hotkey → capture voice → route). Screenshots are the same
pipeline shape with a different sense organ. MF runs 24/7 on BOTH machines (home + work) and
already owns the expensive parts: hotkey plumbing, tray residency, overlay UI, autostart.
A standalone screenshot utility would rebuild all of that twice.

## Agreed architecture (defend these in the grill)
1. **Mistr Flow = host daemon.** Owns the hotkey (sketch: `Ctrl+Shift+\``), does
   **active-window capture first** (`w` default; `r` region / `m` monitor later), shows a
   small picker overlay in MF-native chrome: numbered actions, two keystrokes total
   (hotkey, digit), Esc cancels.
2. **The action menu is SERVED by Control Room, not registered in MF** (revised
   2026-07-14 — this beats an in-MF registry). Flow: capture → `POST /captures`
   (pixels + window title + process name) → CR stores + **enriches at intake** (live
   session, branch, work-context, running batch, timestamp — the state at the moment
   of capture) → the response carries a capture-id AND the available-actions list →
   MF renders whatever came back; picking a digit fires
   `POST /captures/:id/actions/:action`. Adding a new verb (Teams "Send to Scott",
   Hermes "Ask about this") is a CR-side change — **zero MF releases, ever**.
3. **MF's only smarts: two hardcoded offline fallbacks.** When CR doesn't answer,
   the menu is the local built-ins `Clipboard` / `Save…`. MF never learns what git,
   a session, a handoff, or "Scott" is — it asks "who wants this capture?" and renders
   the answer. Keep **stable number slots** (1 Clipboard, 2 Save always local; CR verbs
   from 3+) so muscle memory survives CR being down.
4. **Name it "Capture", not "Screenshot"** — the payload is evidence, and CR-side
   enrichment is what upgrades pixels → evidence.

## Evidence for the priorities (from the 2026-07-12 weekend)
- ~10 screenshots pasted into agent chats; **100% were active-window**, zero region-selects
  → window-first covers nearly everything.
- A dozen GitHub issues were filed where a screenshot was the core evidence, hand-carried
  → `Add to issue` and `Attach to session` are the killer verbs.

## Grill questions to open with
- MF-side: which hotkey (conflicts with existing dictation binds?), capture API on Windows
  (this is a TS/Node app — native module vs PowerShell/Win32 helper?), where the picker
  overlay fits in MF's existing UI shell, save-location defaults.
- Split of work: MF-side (hotkey, capture, overlay, registry, POST) vs Control-Room-side
  (`/captures` intake, enrichment, where captures surface — session timeline event? issue
  comment via gh? evidence stream?). Likely TWO repos' worth of issues
  (`bmac902/mistr-flow` + `bmac902/coding-agent-observer`).
- Menu protocol details: POST-before-pick means a cancel leaves an **orphaned capture**
  (TTL sweep on CR side?); response shape for the actions list; auth (localhost-only?).
- Stable numbering across CR-up/CR-down states (muscle memory > dynamic lists).
- v1 cut line: clipboard + save + one CR verb? Which one?

## Context you won't find in this repo
- Control Room (`C:\dev\coding-agent-observer`) just had a huge weekend: it now runs a
  proven **batch factory** (curated Sandcastle batches → inbox harvest → CI-gated merge).
  Blair's flow is to have the factory BUILD these issues once filed — write them
  agent-ready (exact files, acceptance criteria). See that repo's
  `docs/weekend-handoff-2026-07-13.md` for orientation.
- Mistr Flow already has a Sandcastle image (`sandcastle-mistr-flow:latest`) from an
  earlier era — expect drift; run the `sandcastle-preflight` skill before any batch here.
- Blair's conventions: always branch before editing; he drives UI-surfaced verbs himself;
  issues over inline fixes for review findings; this `docs/handoff/` dir is local-only
  (ignored via `.git/info/exclude`, added 2026-07-14 — NOT in the tracked .gitignore).

## Suggested skills
- **`grilling` / `grill-with-docs`** — the immediate next step (this is a design session).
- **`to-prd` / `to-issues`** — after the grill, to turn it into the epic + curated issues.
- **`sandcastle-preflight`** — before any batch run in THIS repo (stale install likely).
- **`codebase-design`** — for the MF-side seam (capture core vs capability registry).

## Prior handoff in this repo
`2026-06-21-post-pr21.md` — predates all of this; read only if MF internals context is needed.
