# focusOnDeliver raises Herdr's host terminal window, via one socket call

Status: accepted (2026-07-15)

Amends **ADR 0001** on one narrow point: its blanket rule that Mistr Flow speaks only the `herdr` CLI and "never the raw unix-socket protocol." MF now makes exactly two socket calls — `client.window_title.set` and `client.window_title.clear` — and nothing else. Every other Herdr interaction (status, pane list, `agent send`, `agent focus`) still goes through the CLI, unchanged.

## The problem this fixes

`focusOnDeliver` shipped calling `herdr agent focus <target>`. The call succeeded, Herdr's internal state agreed the pane was focused, and **nothing visible happened on screen** — repeated blind trial-and-error against it burned an entire session.

The reason, established live rather than reasoned about:

**Herdr owns no operating-system window.** Both `herdr.exe` processes (client and server) report `MainWindowHandle = 0`. Herdr is a TUI; its UI is painted by a *host terminal* — here Windows Terminal — which is the only real window in the chain:

```
explorer.exe
└── WindowsTerminal.exe   hwnd=67290   <- the only window
    └── pwsh.exe          hwnd=0
        └── herdr.exe     hwnd=0       (client)
            └── herdr.exe hwnd=0       (server) -> agent panes
```

So `herdr agent focus` was never insufficient — it was never *addressing the right thing*. It moves focus inside a window that nobody raises. Herdr's server log confirms the CLI side already does its whole job, cascading on a single call:

```
request_id="cli:agent:focus" method="agent.focus" changes_ui=true
  workspace focused  workspace_id="w8"
  tab focused        tab_id="w8:t1"
```

That also retires the prior handoff's guess that `herdr workspace focus`/`herdr tab focus` might be needed too. They are not.

Herdr's API cannot raise the window, and could not be expected to: of the 172 symbols in `herdr api schema` (protocol 16), none raises, activates, or foregrounds anything. The only window-touching calls are `client.window_title.set`/`.clear`. The window isn't Herdr's to raise.

## Why the socket, and why only for this

Identifying the host window is the hard part, and it is why a config-only or CLI-only fix does not work:

- Windows Terminal runs **every window in one process**, so pid → window is one-to-many. Blair had two WT windows, same pid (23340), both titled "PowerShell", both real (neither cloaked nor minimized).
- `MainWindowHandle` returns whichever is first in **z-order** — it silently changed between two probes minutes apart. It is not an identifier.
- Both host shells are plain `pwsh.exe` from the default profile, with no `tabTitle`. Herdr is launched ad hoc by typing `herdr`. There is no passive discriminator to match on.

The only durable discriminator is one we mint: set a nonce as Herdr's window title, find the window wearing exactly that title, restore the title. It is exact, needs no user setup, and cannot collide. `client.window_title.set` has **no CLI equivalent**, so this is the one thing the CLI cannot do.

ADR 0001's stated reason for rejecting the socket was that "the CLI is the supported control surface; the socket protocol carries no compatibility promise." That premise does not survive contact with the evidence:

- The socket protocol is **publicly documented** (herdr.dev/docs/socket-api/), **versioned** (`protocol: 16`, with `capabilities` negotiated via `ping`), and ships a **machine-readable JSON Schema** (`herdr api schema`) — the artifact you publish precisely so third parties can build clients.
- **The CLI is itself a socket client.** Herdr's own log labels CLI traffic `request_id="cli:agent:focus" method="agent.focus"` — the identical method over the identical socket. The CLI is a wrapper, not a separate, stabler contract; it carries no compatibility promise the socket lacks.

ADR 0001 also named the trigger for its own supersession: "a direct-Herdr limitation exposed by the delivery spike." This is exactly that limitation.

## Consequences

- **The socket exception is one module and two methods** (`src/herdrSocket.ts`). Widening it needs a new decision; it is not a general licence to bypass the CLI.
- **The socket path is discovered, not guessed** — `herdr status --json` reports `server.socket`. No `%APPDATA%`/XDG reconstruction, and it stays correct for `--session`-scoped sockets. A build that doesn't report it simply disables window raising.
- **Everything here is best-effort.** Every failure is a `skipped` code, never a throw. A delivered capture stays delivered even if the window won't come forward, preserving ADR 0001's delivery guarantee.
- **The window title is always restored**, including on failure (Herdr reasserts its own "herdr" title on clear). The sentinel is worn for a few hundred ms and reads as intentional if a crash strands it.
- **`focusOnDeliver` remains opt-in and `false` by default.** This changes the mechanism, not the "never steal focus" default.
- **Cost is ~1.35s**, dominated by PowerShell process startup, not the Win32 work. A compile-free `AppActivate` fast path was measured (1017ms vs 1095ms) and rejected: it saves ~80ms and *fails outright on a minimized window*.
- **Linux/macOS are unaddressed.** The mechanism is Win32-specific, matching MF's existing Windows-only helpers.

## Evidence (all verified live, 2026-07-15, herdr 0.7.2-preview / protocol 16)

Recorded because ADR 0001's socket claim was plausible and wrong, and because #27's adapter passed a full mocked suite while being wrong about every field. Mocked tests cannot produce any of the following:

- Naive `SetForegroundWindow` from a non-foreground process **fails** (`returned=False`); attaching to the current foreground thread's input queue (`AttachThreadInput`) first makes it **succeed**.
- `SW_RESTORE` is required before activation: COM `AppActivate` returns `False` on a minimized window and leaves it iconic.
- A single `SetForegroundWindow` fired during the un-minimize animation is refused — the helper retries and escalates to `SwitchToThisWindow`. Verified 5/5 from the hard case (Herdr minimized + another window holding foreground).
- Herdr's socket listener hands out a **dead pipe instance on the first connect after idle**: attempt #1 fails with EPIPE, #2 succeeds. A single-shot client makes a healthy socket look broken. `src/herdrSocket.ts` retries for this reason.
- On Windows the socket is a **named pipe whose name is the socket path verbatim** (`\\.\pipe\C:\Users\...\herdr.sock`); the `.sock` file itself is a 25-byte `pid:startTimeNanos` rendezvous file, not a socket.
