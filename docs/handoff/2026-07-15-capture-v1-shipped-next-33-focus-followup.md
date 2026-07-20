# Handoff — Capture v1 shipped and proven live → next: #33 (work machine), close out #28/#29 — 2026-07-15

## Start here (next session)

The Capture verb (screenshot → picker → deliver into a live Herdr agent pane) is **built, merged, pushed, and proven working live** — not just passing tests. Your job is administrative/verification cleanup, not new feature work:

1. **Issue #33** — human two-machine verification. Do this on the **work machine**: `git pull`, build, run the app, confirm the full loop (hotkey → capture → picker → real delivery) on that host too. This is also what closes out the "per eligible agent type" and "both machines" acceptance bullets still open on **#28** (the delivery spike) — #28 stays open until that second-machine/second-agent-type pass happens.
2. **Issue #29** (Claude Design mascot states) — the deliverable already shipped (see `28f9489`). Close the issue; nothing left to build.
3. Optionally pick up the **`focusOnDeliver` open question** — see "What's still unresolved" below. Not blocking, no issue filed for it yet; file one if you want to keep chasing it.

Repo is fully in sync: `main` at `634dc15`, pushed to `origin/main`, working tree clean except `.sandcastle/batch.json` (benign, expected — see `sandcastle-preflight`).

## What shipped

All of PRD #24 (`gh issue view 24 --repo bmac902/mistr-flow`) is built and merged: #25 (verb arbiter/lock), #26 (capture helper), #27 (Herdr adapter — query side), #30 (core tracer), #31 (picker UI), #32 (delivery execution), plus the Claude Design integration (#29's deliverable). Architecture is ADR 0001 (`docs/adr/0001-capture-v1-direct-local-herdr-cli-integration.md`): direct Mistr Flow → local Herdr CLI, no Control Room in the path.

Full design/decision record lives in `CONTEXT.md` — glossary terms *Capture* and *Eligible Target*, and every Capture decision including the corrections below. Read that before touching this code; don't re-derive it from the source.

## The big lesson from tonight — read this before trusting any Herdr-adapter code

**#27's original adapter was built and unit-tested against a completely invented `herdr` CLI schema that never matched reality.** It passed its own tests (mocked execFile against its own fictional fixtures) and was merged after typecheck+tests passed — but nobody ran the real `herdr` binary to cross-check. It broke the instant the actual app was used live. Specifics, all corrected in `634dc15`:

- Availability check called a nonexistent `herdr version --format json`; real command is `herdr status --json` (nested `server.running`/`server.protocol`).
- `herdr pane list --format json` errored (no such flag); real command takes no flags and wraps output in `{ result: { panes: [...] } }`, not a bare array.
- Real pane fields are `agent`/`agent_status`/`agent_session`/`terminal_id` — not the invented `label`/`target_id`/`agent_name`/`title`.
- `SUPPORTED_PROTOCOLS` was hardcoded to `[1]`; real Herdr reports `16`.
- Delivery used `herdr pane run <target> <path>`, which only accepts the **compact positional pane_id** — never a durable identity. `herdr agent send <target> <path>` is the command that actually accepts `terminal_id`, confirmed live.
- The adapter preferred `agent_session.value` as the durable id (looked equally plausible) — `agent send` rejects it outright (`agent_not_found`). **`terminal_id` is the only field confirmed to work.**

**The takeaway, not just the bug list:** any code that talks to an external CLI/API needs one live smoke-test command run at review time, not just mocked-test trust. Apply that standard to any future Herdr-adapter changes.

## What's still unresolved

- **`focusOnDeliver` config flag** (`config.json`, default `false`): after a successful delivery, optionally calls `herdr agent focus <target>`. The API call succeeds and Herdr's own internal state confirms the pane is "focused" — but it produces **no observable visual/keyboard effect** on Blair's screen. Not a code bug we can currently see a fix for: no way to verify Herdr's actual rendered UI from the agent side, only Blair's eyes can confirm anything here, and repeated blind trial-and-error was costing his patience. Shelved as a known limitation, documented in `CONTEXT.md`. If picked back up, don't assume `herdr agent focus` is the whole answer — `herdr workspace focus`/`herdr tab focus` may also be needed to actually bring the right area of Herdr's UI into view, and none of that may bring the Herdr *window* itself to OS foreground.
- Delivery sometimes lands as plain text instead of the CLI auto-upgrading the path into a real image attachment. Working hypothesis (unconfirmed): the target pane needs to be idle at the exact moment of delivery, not mid-turn. Either way the core guarantee holds — the receiving agent can always `Read` the exact delivered path itself, confirmed multiple times live tonight.
- The picker can transiently drop an eligible pane if its `agent_status` is briefly something other than `idle`/`working` (e.g. `blocked` mid-tool-call) — `ACTIONABLE_STATUSES` currently only allows `idle`/`working`. Whether `blocked` should also count as actionable is an open product question, not yet decided or built.

## Suggested skills

- **`sandcastle-preflight`** — run before firing any further batch in this repo.
- **`side-monitor`** or manual `herdr` skill use — useful for watching a live capture/delivery attempt the way this session did (tail the app's own log output; `console.log`/`console.warn` diagnostics were added to `src/deliver.ts` and `src/main.ts` tonight specifically because this was otherwise being debugged blind).
- **`domain-modeling`** — if the `blocked`-status or focus-follow questions get resolved, record the decision in `CONTEXT.md` the same way this session did, inline, as it's decided.

## Prior handoffs in this repo

`2026-07-14-capture-capability-seeded-next-grill-and-epic.md` — the grill session and issue breakdown that led to everything above. `2026-06-21-post-pr21.md` — predates Capture entirely, read only if pre-existing dictation internals context is needed.
