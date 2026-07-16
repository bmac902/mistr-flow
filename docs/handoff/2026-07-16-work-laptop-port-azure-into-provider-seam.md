# Handoff — WORK LAPTOP: port Azure into the new provider seam, reconcile today's work — 2026-07-16

> **This file is force-added (`git add -f`) so it reaches the work machine.** `docs/handoff/` is gitignored via `.git/info/exclude` (machine-local, does not travel) — a normal handoff here would never leave the home machine. If you write another cross-machine handoff, force-add it too.

## Start here (work laptop, the Azure AI Foundry fork)

Two things, in order:

1. **Pull everything from `bmac902/main`.** A large amount shipped on the home machine today (see "What shipped"). The work fork needs all of it.

2. **Port the Azure adapter into the new AI-provider seam (#43 follow-up). This is the headline task and should be the *last* fork reconciliation these two lineages ever need.** Details below.

Then the human verifications (#40, #42, #44 spike) whenever.

## The provider seam — what to plug Azure into (#43)

`#43` (merged, `eeb9248`) killed the fork's root cause: the AI provider was the one external dependency with no port. Now it has one. The seam:

- **`src/aiProvider.ts`** — `interface AiProvider { transcribe(...); polish(...) }` (the entire surface Mistr Flow needs), and `defaultAiProviderRegistry` — a `Record<string, AiProviderFactory>` mapping provider name → factory. It currently holds `openai: () => createOpenAiProvider()`. The registry is the extension point; the comment in the file literally says *"This is where Azure lands: `azure: () => createAzureProvider()`."*
- **`src/openaiProvider.ts`** — the reference adapter. Copy its shape for Azure.
- **`resolveAiProvider(name)`** reads `"provider"` from config (default `"openai"`), looks it up in the registry, fails loudly on an unknown value (never silently falls back).

**The port (a move of code that already works, not new invention):**
1. Create `src/azureProvider.ts` — `createAzureProvider(): AiProvider`, built by lifting the fork's existing, working Azure AI Foundry transcribe/polish logic behind the `AiProvider` interface. **Do not invent an Azure client — this is the fork's proven code, reshaped.** This machine can actually reach Azure, so verify it live.
2. Its factory **reads its own config fields** (`azureEndpoint`, `azureApiKey`, `azureApiVersion`, `transcribeDeployment`, `polishDeployment`) — `config.ts` must stay ignorant of Azure's field names. This is the decision that keeps `config.ts` out of the merge-conflict zone permanently.
3. Register it: add `azure: () => createAzureProvider()` to `defaultAiProviderRegistry`.
4. Set `"provider": "azure"` in this machine's `%APPDATA%\MistrFlow\config.json` (see per-machine config below).
5. The `resolveAiProvider` "fails loudly on unknown / never silent-fallback" test already exists; add Azure-adapter tests mirroring `openaiProvider`'s.

**Fork-reconciliation note:** yesterday's merge had 5 conflicts (`main.ts` startup block, `config.ts`, `test/config.test.ts`, `.sandcastle/*`). After #43, `main.ts`'s startup is provider-agnostic and `config.ts` knows no Azure fields — so today's pull should conflict *far* less. If it still fights in the provider area, that's the signal the fork hasn't fully adopted the seam yet.

## What shipped on home today (reference — don't re-read the diffs unless needed)

All on `origin/main`. Headlines, newest first:
- **Relay verb** (the clipboard as a third sense: copy → `Ctrl+Alt+C` → pick a pane → delivered). Issues #37–#40; PRD #24 lineage. Plus **file relay** (#42, `e2fba50`) — copy a file in Explorer, its path is relayed; a `.py` gets Read, a `.png` gets seen.
- **`copySelectionFirst`** (opt-in): the Relay hotkey simulates Ctrl+C first, so select → hotkey → digit. `3c2a576`.
- **Refusal self-clears** instead of sticking until Esc (`3c2a576`), and the **refused wag pivots on the cane** per a Claude Design correction (`ce49ab3`).
- **Claude Design Relay mascot states** integrated (`dd85bc4`, #41 — now closed).
- **AI-provider seam** (#43) — the thing you're extending.
- **Bracketed-paste fix**: multi-line relayed text arrives as one atomic paste (was landing tail-only). In `deliver.ts`.
- **Decisions** are in `CONTEXT.md`; architecture in `docs/adr/0001` (direct Herdr CLI) and `0002` (the single socket exception for window-title).

## New this session, NOT yet built — the next feature arc

- **#44 — PRD: fleet awareness** (promoted from a seed to a full PRD this session; `ready-for-human`). The big idea: the resident bar becomes the ambient *pulse of the fleet* — the butler's bearing reflects how many agents are `blocked` (waiting on you), plus a hotkey/click to jump to the longest-blocked one. **A live calibration spike already ran** (findings are in the PRD): `blocked` fires reliably on a permission prompt and *holds* (58.7s measured, persists until answered); zero transient flickers seen. Calibrated numbers: dwell ≈5s, poll ≈3–4s, ding ≈3–5min. **Work-machine spike re-confirmation** (does `blocked` fire for *your* real agents here?) is the one remaining spike item before slicing. Next step for #44: `/to-issues` to slice it (spike re-confirm → pure `fleetState` module → Claude Design postures → ding + click).
- **#45** — voice that can route to a pane (not just paste). Idea seed.
- **#46** — "same agent again" repeat-last-target. Idea seed.
- **#47** — make the resident bar a clickable launcher (inherits #44's click-vs-drag infra). Idea seed.

## Per-machine config (NOT in the repo — set on THIS machine)

`%APPDATA%\MistrFlow\config.json` is per-machine and gitignored. On the work laptop you must set:
- `"provider": "azure"` **plus** the azure fields (`azureEndpoint`, `azureApiKey`, `azureApiVersion`, `transcribeDeployment`, `polishDeployment`) — the seam won't reach Azure without them.
- Optionally, to match the home experience: `"copySelectionFirst": true`, `"focusOnDeliver": true`. Both default off.

## Gotchas (from CLAUDE.md, still true)

- `npm start` = build + launch; **`dist/` is gitignored**, so a fresh pull has no build until this runs.
- The desktop shortcut is pinned to the folder it was made in — re-run `install:shortcut` in this folder or just `npm start`.
- Capture/Relay have **no visible UI change** at rest — the difference is what happens after the hotkey.

## Suggested skills

- **`codebase-design`** — for shaping `azureProvider.ts` against the `AiProvider` port cleanly (the seam is the whole point).
- **`verify`** / **`run`** — drive the app live after the Azure port; this machine can actually reach Azure, so confirm transcribe+polish end-to-end, not just typecheck.
- **`to-issues`** — when you're ready to slice #44 (fleet awareness) into buildable issues.
- **`sandcastle-preflight`** — before any batch run in this repo (image drift is likely on a different machine).
- **`grilling` / `domain-modeling`** — if #45/#46/#47 get picked up; they're seeds needing a design pass.

## Prior handoff

`2026-07-15-focus-on-deliver-fixed-next-33-work-machine.md` — the previous cross-machine handoff. Everything it pointed at (#33, Capture) has since shipped.
