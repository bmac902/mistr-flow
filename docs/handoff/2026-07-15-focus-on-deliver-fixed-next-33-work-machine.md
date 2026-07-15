# Session — focusOnDeliver fixed and proven live; next: #33 (work machine) — 2026-07-15

> Deliberately in `docs/sessions/` and **committed**, not `docs/handoff/` — that folder is excluded via `.git/info/exclude`, which is machine-local and does not exist on the work laptop. This file has to survive a `git pull` at work.

## Start here (next session, probably on the work machine)

**Issue #33 — two-machine verification.** Everything below already works on the home machine, verified live in the real app. At work:

1. `git pull` (main is at `3e53f7d`), `npm start`.
2. **Set `focusOnDeliver: true` in `%APPDATA%\MistrFlow\config.json`** — it is opt-in and defaults to `false`. The work machine's config is a *different file*; it will not have this. This is the single most likely reason "it doesn't work at work."
3. Hotkey → capture → picker → pick an agent → your cursor should land in the Herdr pane, ready to type.
4. That closes #33, and with it the "both machines" bullet still open on **#28**.

Also open on #28: **"per eligible agent type"** — at work you have Copilot and Claude. Claude is proven; **Copilot is the one type never confirmed** (see table below).

## What shipped (don't re-derive — read these)

- **ADR `docs/adr/0002-focus-on-deliver-raises-the-host-terminal-window.md`** — the whole diagnosis and every piece of live evidence. Read this before touching focus code.
- **PR #34** (merged, `3e53f7d`) — the fix.
- **`CONTEXT.md`** — Capture decisions, including the corrections below.
- Issue comments on **#28** carry the per-agent-type and auto-attach results.

**One-line summary of the bug:** `focusOnDeliver` wasn't broken, it was aiming at the wrong thing. **Herdr owns no OS window** (`MainWindowHandle=0` on every herdr process). It's a TUI painted by a *host terminal*, so `herdr agent focus` moves focus inside a window nobody raises. Fix = `agent focus` (unchanged) **plus** raising the host terminal window, identified by minting a nonce title via `client.window_title.set`.

## If focus misbehaves at work — debug here first

MF logs the outcome on every attempt. Look for either line:

```
[mistr-flow] focusOnDeliver: raised herdr window <hwnd>          <- worked
[mistr-flow] focusOnDeliver: pane focused but window not raised: <code>
```

`<code>` is the whole diagnosis (`src/herdrWindow.ts`):

| code | meaning |
|---|---|
| `socket-path-unknown` | `herdr status --json` didn't report `.server.socket`. Older/other herdr build. |
| `socket-unreachable` | Couldn't talk to the socket after retries. Is herdr running? |
| `no-foreground-client` | herdr server is up but **no TUI client is attached** — there is genuinely no window to raise. |
| `window-not-found` | Title was set but no window wore it. The host terminal may not apply OSC titles. |
| `foreground-refused` | Windows refused the foreground handoff even after retry + `SwitchToThisWindow`. |
| `helper-not-found` | `powershell` not runnable. |
| `helper-error` | The helper script itself failed. |

Notes that will save time:

- **The mechanism is terminal-agnostic.** It finds the window by title, not by hunting for Windows Terminal — so a different terminal at work should still work, *provided that terminal applies OSC window titles*. If it doesn't, you'll see `window-not-found`, and that's the thing to check first.
- **Never trust `MainWindowHandle`** to identify the herdr window. It returns whichever window is first in z-order and changes as windows are raised. This burned an hour.
- Cost is ~1.35s, dominated by PowerShell startup. Not a bug.
- All failures are best-effort: **a delivered capture stays delivered** even if the window won't come forward.

## Per eligible agent type — live results (#28)

Same PNG delivered to each via `herdr agent send`. Three passes, three *different* mechanisms — which is the design working:

| agent | how it gets the image | verdict |
|---|---|---|
| **hermes** | auto-attaches natively (`attaching 1 image(s) natively (model supports vision)`), described the image correctly | **PASS** |
| **claude** | auto-attaches **only when idle**; mid-turn it lands as plain text (still `Read`-able) | **PASS** (idle) |
| **codex** | no auto-attach — calls a `Viewed Image` tool on the path, described it correctly | **PASS** |
| **copilot** | text delivers fine; **image access never confirmed** — prompt was loaded into its pane awaiting a human Enter | **UNCONFIRMED** |

**Copilot is the open one, and work is where you have it.** Note: copilot ignores a *programmatic* Enter (`send-keys`, `pane run` all no-op'd) — that's a test-harness limitation, **not** an MF bug. MF deliberately never sends Enter; it leaves the path in the box for the human. Copilot submits fine when a human presses Enter (proven: `test message` → `Received`).

Codex needed `codex-cli >= 0.144.4` — an older CLI 400s on `gpt-5.6-terra`. Updating the binary is not enough; **the pane must be killed and relaunched** (the old binary stays loaded).

## Two beliefs that were wrong (both were plausible, written down, and never checked)

1. **"Herdr's own image-path detection upgrades the path into an attachment."** False. Herdr's 232KB API schema has **zero** occurrences of `image`/`attach`/`multimodal`/`paste`/`upload`/`media`; `agent send` is literally `<target> <text>`. **Herdr transports text, full stop.** The upgrade is the *receiving agent CLI*. So **no Herdr-side flag or version will ever change auto-attach** — don't go looking there.
2. **ADR 0001's "the socket protocol carries no compatibility promise."** It's publicly documented, versioned (`protocol: 16`), ships a JSON Schema (`herdr api schema`), and **the CLI is itself a socket client**. ADR 0002 amends this for exactly two methods.

Both are the same failure mode as #27's invented adapter schema. **Run the real binary once before believing anything about it** — `herdr api schema`, `herdr api snapshot`, `herdr status --json`, and herdr's own logs at `%APPDATA%\herdr\herdr-server.log` are the authoritative sources.

## Open decision (not built, no issue filed)

**Wait for idle before delivering?** Herdr exposes `herdr agent wait <target> --status idle --timeout MS`. MF *could* wait for the chosen pane to go idle and buy reliable auto-attach — but against the 3s delivery-ack deadline, and a working agent may not go idle for minutes. Today the picker deliberately offers both `idle` and `working` panes, so a user can knowingly deliver mid-turn and get plain text plus a `Read`-able path. Needs a product call; file an issue if pursued.

Other known-open (unchanged from prior handoff): whether `blocked` should count as actionable in `ACTIONABLE_STATUSES`.

## Herdr gotchas worth knowing (now also in the `herdr` skill)

- **First socket connect after idle returns a dead pipe** — attempt #1 EPIPEs, #2 succeeds. A single-shot client makes a healthy socket look broken.
- On Windows the socket is a **named pipe named after the path verbatim**; the `.sock` file is a `pid:startTimeNanos` rendezvous file, not a socket.
- **`agent.focus` already cascades** workspace+tab+pane. Do not add `workspace focus`/`tab focus`.
- `herdr wait agent-status` returned an `internal_error` ("failed to deco…") during this session — `pane read` polling worked instead. Minor, unfiled.
- **Read a pane before sending into it.** An `agent send` mashed on top of Blair's unsent draft this session. The skill says to check first; do it.

## Suggested skills

- **`herdr`** — now carries all the focus/window/socket findings above. **Merged to `bmac902/skills` (PR #1) — `git pull` that repo at work**, along with an updated `side-monitor`.
- **`diagnose`** — if focus misbehaves at work, use the skip-code table above as the reproduce/instrument step rather than guessing.
- **`domain-modeling`** — if the wait-for-idle or `blocked`-status questions get decided, record them in `CONTEXT.md` inline, the way this session did.
- **`sandcastle-preflight`** — before firing any batch in this repo.

## State

`main` @ `3e53f7d`, pushed. Working tree clean apart from long-standing untracked `.sandcastle/batch.json`, `assets/# Mistr Flow Capture States.zip`, `assets/overlay.ts`. Typecheck clean, 175/175 tests pass. `#29` closed; `#28` and `#33` open.

Prior handoff: `docs/handoff/2026-07-15-capture-v1-shipped-next-33-focus-followup.md` (home machine only — excluded from git).
