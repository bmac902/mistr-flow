# Capture v1 uses direct local Herdr CLI integration

Status: accepted

Capture v1 exists to solve one concrete, evidenced problem: copy/paste friction getting a screenshot of the active window into a live local Herdr agent pane (75–90% of Blair's real screenshot traffic). Mistr Flow integrates with Herdr **directly**, by shelling out to the supported `herdr` CLI — MF queries eligible agent panes, renders them in its picker, and delivers the capture through the same CLI. No Control Room component sits in the path: no HTTP intake service, bearer tokens, capture-upload protocol, or CR deployment on either host.

## Considered Options

A Control-Room-mediated architecture was seriously designed first (capture POSTed to CR, CR enriches at intake and *serves* the action menu, MF renders whatever comes back — new verbs become CR-side changes with "zero MF releases, ever"). It was set aside for v1 because it introduces a service, a wire protocol, auth, TTL sweeps, and a two-repo deployment obligation solely in anticipation of speculative future verbs, while the actual v1 destination is one local integration away. Speaking Herdr's unix-socket protocol directly was also rejected: the CLI is the supported control surface; the socket protocol carries no compatibility promise.

## Consequences

- **This defers, rather than forbids, an MF↔Control Room adapter.** A later ADR may supersede this one when a demonstrated need exists — for example: a real second destination, a direct-Herdr limitation exposed by the delivery spike, or proven CR reuse that reduces rather than adds complexity.
- **"Future verbs require an MF release" is an accepted v1 trade-off, not a permanent product constraint.**
- The design deliberately preserves adapter/relay compatibility: durable target identities (not positional pane ids), MF-minted capture UUIDs, and idempotent delivery keyed per capture + target survive a later CR or cross-machine architecture without a breaking change.
- MF gains a deliberately thin Herdr adapter (panes, agent labels/status, delivery) but still learns no git/session/issue semantics.
