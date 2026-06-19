# Mistr Flow — Context

## Glossary

**Session** — one press-to-release cycle of the hotkey: from hold-to-record start, through recording, transcription, and Polish, to paste (or error/cancel).

**Raw Transcript** — the unmodified output of the speech-to-text engine for a Session. Never shown to the user in v1; exists only as Polish's input.

**Polish** — the cleanup step that turns a Raw Transcript into the text that gets pasted. Scope is deliberately narrow:
- DOES: fix punctuation and grammar, format spoken lists into actual list structure.
- DOES NOT: remove, reorder, or merge content based on inferred self-correction ("scratch that," restating a thought, etc.) — every word the speaker said survives into the pasted text, even if they misspoke. No semantic judgment calls, no inferred intent beyond punctuation/grammar/lists.
- DOES NOT: rewrite tone, vocabulary, or voice. Casual stays casual. No LinkedIn-ification.
- Rationale: the courier (Polish) must not overthink things. Anything beyond mechanical cleanup risks silently dropping content the user wanted kept — a stricter rule was preferred over a smarter one.

## Decisions

- **Listening confirmation**: hotkey-down triggers a floating overlay (mascot tips-hat sprite + live waveform) plus a tiny beep, confirming recording has started.
- **Hotkey model**: hold-to-record (push-to-talk). Release = stop recording and send for transcription. Rejected toggle mode for v1.
- **Paste behavior**: auto-paste immediately when Polish finishes — no preview/confirm step.
- **Self-correction handling**: none in v1. Considered trigger-phrase detection ("scratch that") and general LLM judgment; rejected both in favor of doing nothing, to guarantee Polish never drops content the user said.
- **Hotkey**: Ctrl+Win, held (hold-to-record). Hardcoded for v1, matches existing Wispr Flow muscle memory.
- **APIs**: OpenAI end-to-end — Whisper API for transcription, gpt-4o-mini for Polish. Single vendor, uses existing OpenAI API credit. (Note: Claude Pro is a chat subscription, not API credit — not usable here without separate Anthropic API billing.)
- **Cancel**: two paths, both feed the "Cancelled" mascot state (exits stage left). (1) Dead-zone — releasing the hotkey within ~0.3s of pressing is treated as an accidental trigger, auto-cancels, nothing sent. (2) Esc — pressing Esc while still holding the hotkey deliberately aborts a longer recording in progress.
- **Error fallback**: if Polish (cleanup) fails after transcription succeeded, paste the raw transcript instead of nothing — hat still falls off to signal trouble, but spoken words are never silently lost. If transcription itself fails, there's nothing to paste — error toast only.
- **Mascot rendering**: a borderless, always-on-top overlay window using simple looping sprite-sheet animations per state (not single static poses) — e.g. the moustache-wiggle actually wiggles during Recording. No skeletal rigging or animation engine.
- **API key storage**: plain JSON config file at `%APPDATA%\MistrFlow\config.json`. No Credential Manager, no env var requirement.
- **v1 non-goals (explicitly refused)**: dictation history/transcript log (fire-and-forget, nothing persisted beyond config), a settings UI (hand-edit the JSON file), multi-language/custom vocabulary support (English only, default Whisper behavior).
- **v1 in-scope**: auto-start on Windows boot is acceptable to include.
- **Tech stack**: TypeScript + Electron + React. Chosen over C#/.NET despite Electron's larger footprint, because the user already knows this stack and low-friction-to-build outweighs architectural leanness for a personal tool. Paste-into-active-app requires a native keystroke-simulation library (e.g. `@nut-tree/nut-js`) alongside Electron's `clipboard` module, since Electron alone can't send keystrokes to another app's window.
- **Night-one prototype scope**: full core loop (Ctrl+Win hold-to-record → Whisper transcription → gpt-4o-mini Polish → clipboard + simulated paste into active app), with placeholder mascot visuals (static shapes/text per state, not real art). Proves the technically risky part end-to-end.
- **Weekend-pass scope**: real animated mascot artwork (sprite-sheet loops per state) replacing the night-one placeholders; auto-start on boot.
- **Paste targeting**: pastes into whatever app is focused at the moment processing/Polish completes — not the window that was active when recording stopped. Known sharp edge (switching windows mid-process can mis-target the paste); accepted as a simplicity trade for v1.
- **Overlay placement**: bottom-center, just above the taskbar, on the monitor with the focused window — matches Wispr Flow's existing placement, which the user is already used to.
- **State timing**: no artificial minimum duration for Processing/Polishing — states last exactly as long as the real API calls take. Not pre-optimizing for a hypothetical "too fast to see" case.
- **Transcription mode**: batch only — record the full clip locally while the hotkey is held, send one complete audio file to Whisper's standard endpoint on release. No streaming/Realtime API.
- **Idle/at-rest presence**: a small black bar floats persistently above the taskbar at all times the app is running (matches Wispr Flow's pattern) — not tray-icon-only. At idle, only the mascot's hat and eyes peek above the bar. Pressing the hotkey grows the same bar into the larger active overlay with a live waveform; the mascot "gets up" and plays its fuller per-state animations (tip-hat, moustache-wiggle, cane-twirl, bow, etc.) during the active session.
- **Quit/controls**: right-click the persistent bar for a context menu (Quit, open config file). No separate system tray icon — the bar is the only UI surface.
