# Handoff — CRLF/EOL recovery after the 2026-07-18 Sonnet-5 batch

- **Date:** 2026-07-18
- **Machine:** home (RALPH)
- **Audience:** the work-laptop agent (and future me)
- **Status:** `main` history rebuilt locally; **not yet pushed** at time of writing.

## TL;DR

A Sandcastle batch (issues **#86, #87, #88, #90**, model `claude-sonnet-5`) ran clean
and all four fixes landed as `RALPH:` commits. But those commits silently flipped
line endings **LF→CRLF** on every file they edited. Root cause: this repo had **no
`.gitattributes`**, and `branchStrategy: head` bind-mounts the Windows (CRLF) working
tree into the Linux batch container, whose git committed the CRLF bytes verbatim.

I recovered by **rebuilding `main`'s history as LF**, adding a `.gitattributes` that
prevents recurrence, and doing a **one-time repo-wide normalization to LF**. The code
is byte-identical to the batch output — only line endings changed (verified with
`git diff --ignore-cr-at-eol`: the only content delta is `.gitattributes` itself).

**You must reset the work-laptop clone to the new `origin/main`.** Commands below.

## What `main` looks like now

Old commits (removed from `main`, preserved in branch `backup/pre-eol-fix` @ `a40af43`):

    1b8a5c4 #86   9620871 #87   941fabd #88   a40af43 #90     ← CRLF-polluted

New `main` (all LF):

    80cdc13  feat(overlay)…                         ← unchanged base = origin/main
    6099db5  chore(git): add .gitattributes + normalize all line endings to LF
    397ae3e  RALPH: fix #86 — Relay slot 1 writes a cropped image to the clipboard
    9d807fb  RALPH: fix #87 — Herald outer pane-query deadline respects its own copy
    0dec5e4  RALPH: fix #88 — extract parseFileDropListOutput (unit-testable)
    8638b7f  RALPH: fix #90 — non-Explorer file drop no longer dropped silently
    <this handoff commit>

## Why it happened (and why ~20 prior batches didn't show it)

- No `.gitattributes` + host `core.autocrlf=true` → repo blobs are LF, working tree is CRLF.
- `branchStrategy: head` **bind-mounts** that CRLF working tree into the container.
  The container git (`core.autocrlf=false`, no attributes) commits CRLF verbatim →
  LF-to-CRLF flip on every edited file that was LF at baseline (7 files this batch).
- Earlier batches mostly ran on *coding-agent-observer*, and/or their CRLF was silently
  renormalized when merged on a Windows host — so it was never visible until we
  inspected the **raw, pre-merge** RALPH commits this time.

## The fix — won't recur

`.gitattributes` now pins:

    * text=auto eol=lf

LF is enforced in the repo **and** the working tree on every machine and inside the
container, so no future batch can store CRLF. This is the important permanent change.

## Work-laptop: reset to the new main

The old commits were never pushed, so on the home machine this is a **fast-forward
push, no `--force`**. On the **work laptop**, run:

```bash
# 0. Park any local work — reset --hard discards uncommitted changes.
git status
git stash -u                 # only if 'git status' shows anything

# 1. Fetch the rebuilt main
git fetch origin

# 2. Point local main at it (fast-forward; --hard also refreshes if it diverged)
git checkout main
git reset --hard origin/main

# 3. Apply the new line-ending rules to your working tree
git rm --cached -rq .
git reset --hard

# 4. Deps, then carry on
npm install
```

If you stashed in step 0: `git stash pop`, and resolve any (EOL-only) conflicts by
taking the incoming version and re-normalizing.

## Still open (unchanged by this recovery)

- **#86/#87/#88/#90 are implemented but NOT closed** — RALPH leaves a report comment;
  a human reviews + closes. Review each with `git show <sha> --ignore-cr-at-eol` for a
  clean diff. **#90 made a real behavioral change** (new `hasFileDrop()` port replacing
  the `FileNameW` gate) — review that one with extra care; it was the design-decision
  finding, not a mechanical fix.

## Safety net

- `backup/pre-eol-fix` (@ `a40af43`) holds the exact pre-recovery `main`. Delete it once
  everything is confirmed good on both machines.
