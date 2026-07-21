# Mistr Flow

> "Dictate messy. Paste clean." — and, these days, rather more than paste.

Mistr Flow started life as a tiny Windows dictation valet: press a hotkey, speak your rambling, and he tidies it into clean text in whatever app you are already using. He still does that, flawlessly, and it is still the thing he is proudest of.

But he has been promoted. Somewhere along the way the valet learned to carry things — a screenshot to the coding agent that needs to see it, a stack trace from your clipboard, a spoken instruction routed straight into an agent's pane — and to keep half an ear on the household staff while he is at it. What used to be a dictation app is now a **local-first desktop routing layer for your AI workflows**: it polishes speech, captures screenshots, relays clipboard content, and delivers the result to coding agents or desktop AI apps through one unified target picker.

No voice-control grammar. No command language. No SaaS dashboard. Just a cheerful little gentleman who now wears several hats, and never makes you learn a new one.

![Mistr Flow hero: Dictate messy. Paste clean.](docs/readme/mistr-flow-hero.png)

## What the gentleman handles now

Each duty is a single global hotkey. Press it, and the same small overlay grows into whatever the moment needs — a waveform, a preview, a picker of who should receive things.

- **Dictate** — `Ctrl+Alt+D`. The original trick, untouched. Speak, and he transcribes, lightly polishes, and pastes into the active app. A valet, not a ghostwriter: he cleans up your words, he does not reinterpret them.
- **Herald** — `Ctrl+Alt+H`. The same voice, but instead of pasting where you stand, he carries the polished message to an agent's pane and announces it. Dictation's front half joined to delivery's back half.
- **Capture** — `Ctrl+Alt+S`. A screenshot of the active window, treated as *evidence to be delivered*, not a file to be misplaced. Snap it, pick who should see it, and it lands in their pane. Crop it first if only part matters.
- **Relay** — `Ctrl+Alt+C`. Your clipboard, routed the same way — copied code, a stack trace, a URL, an image, a fistful of files. He reads it on demand, never watches or logs it, and hands it wherever you point.
- **Jump** — `Ctrl+Alt+J`. He keeps an ear on your agents (via Herdr) and, on request, takes you to whoever most needs you next — the one that is blocked before the one that is merely finished. A soft, distinct chime marks each, so you can stay heads-down elsewhere and still know.

Capture and Relay both remember your **last ten**, so you can arrow back through recent screenshots or clips in the picker and re-send any of them without re-snapping.

## Where things go

The picker offers a pinned local option (keep it on the clipboard / paste it here) plus up to eight live destinations: **Herdr agent panes** and any **desktop AI apps** you have configured as targets. Pick a number, and off it goes — delivery is idempotent, so a nervous double-tap never sends twice.

**An honest note for the curious:** the *deliver-to-an-agent* half assumes you run [Herdr](https://herdr.dev/) ([source](https://github.com/ogulcancelik/herdr)), a local terminal-agent manager, and/or have configured desktop app targets. Without either, Capture, Relay, and Herald degrade gracefully to "it's safe on your clipboard" — and Dictate works entirely on its own. This is a personal project, actively used every day, and shaped by whichever rough edge surfaced most recently. It is Windows-first and opinionated on purpose.

## The overlay

The overlay is intentionally small and expressive. The mascot gives just enough feedback to be reassuring without stealing attention — a tipped hat while he listens, a wiggle while he thinks, a bow when he is done, a different posture entirely when one of your agents is stuck.

![Mistr Flow overlay states: idle, listening, recording, processing, polishing, done, error, cancelled.](docs/readme/mistr-flow-eight-states.png)

## Current shape

Mistr Flow is a personal, Windows-first Electron app written in TypeScript. It currently assumes:

- A Windows desktop.
- An AI provider for transcription + polish. **OpenAI** is the default; **Azure AI Foundry (Azure OpenAI)** is also supported and selectable by config.
- English dictation.
- A hand-edited JSON config file rather than a settings UI.

The production entry point is `src/main.ts`; the overlay lives in `public/overlay.html` and `public/overlay-renderer.js`.

## Setup

Install dependencies:

```sh
npm install
```

Create the config file at `%APPDATA%\MistrFlow\config.json`. The simplest, default setup uses OpenAI:

```json
{
  "provider": "openai",
  "openaiApiKey": "<your-openai-api-key>"
}
```

`provider` defaults to `"openai"` if omitted. The API key may instead be supplied via the `OPENAI_API_KEY` environment variable.

<details>
<summary>Using Azure AI Foundry instead</summary>

```json
{
  "provider": "azure",
  "azureEndpoint": "https://<your-resource>.cognitiveservices.azure.com/",
  "azureApiKey": "<azure-api-key>"
}
```

`azureEndpoint` and `azureApiKey` come from your Azure AI Foundry resource (Keys and Endpoint). Optional Azure fields: `azureApiVersion` (default `2025-04-01-preview`), `transcribeDeployment` (default `gpt-4o-transcribe`), `polishDeployment` (default `gpt-5-mini`). These may also be supplied via `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_API_VERSION`.
</details>

Everything beyond the provider is per-machine and optional — Mistr Flow starts with sensible defaults for all of it. See [Configuration](#configuration) below for the full set of keys.

Build and run:

```sh
npm run build
npm start
```

`dist/` is gitignored, so a fresh clone has no build until `npm start` (which builds, then launches) runs at least once.

### Configuration

Everything lives in `%APPDATA%\MistrFlow\config.json`. Only the provider key is required; every other key is optional and has a default, so you can add just the ones you want.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `provider` | string | `"openai"` | Which AI provider — `"openai"` or `"azure"`. |
| `openaiApiKey` | string | — | Your OpenAI key (or set `OPENAI_API_KEY` in the environment). |
| `muteSystemAudioWhileRecording` | boolean | `true` | Mute system audio while recording, then restore it. |
| `focusOnDeliver` | boolean | `false` | Raise the target pane/app window after a successful delivery. |
| `copySelectionFirst` | boolean | `false` | Relay simulates `Ctrl+C` first, so a *selection* is grabbed without an explicit copy. |
| `blockedChime` | boolean | `true` | The "an agent is blocked" cue — two quick beeps. |
| `doneChime` | boolean | `true` | The "an agent finished" cue — one soft tone. |

The app also writes `overlayPosition` itself whenever you drag the overlay, so it reopens where you left it — you don't author that one by hand.

Three richer keys have their own shapes:

<details>
<summary><code>vocabulary</code> — a custom dictionary to bias transcription and polish</summary>

Nudges the transcriber toward names it would otherwise mishear, and fixes consistent slips in the polish pass:

```json
"vocabulary": {
  "enabled": true,
  "terms": ["Herdr", "Mistr Flow", "Electron"],
  "phrases": ["red-green-refactor"],
  "replacements": [{ "wrong": "mister flow", "right": "Mistr Flow" }]
}
```

Set `"enabled": false` to switch it off without deleting your lists. Caps: 200 terms, 100 phrases, 100 replacements, 120 characters each.
</details>

<details>
<summary><code>projectAnchors</code> — friendly names and glyphs for picker rows (needs Herdr)</summary>

Maps an agent pane's working directory to a name and a small glyph, so the picker shows "Mistr Flow" with a top-hat instead of a raw path:

```json
"projectAnchors": [
  { "prefix": "C:\\dev\\mistr-flow", "name": "Mistr Flow", "glyph": "tophat" }
]
```

`glyph` is one of `tophat`, `note`, `terminal`, `wing`, `flask`. Matching is case-insensitive and path-boundary aware, and the longest matching prefix wins. An unmapped directory just falls back to its folder name.
</details>

<details>
<summary><code>appTargets</code> — desktop AI apps as delivery destinations (not Herdr panes)</summary>

Lets Capture / Relay / Herald deliver into a normal desktop app (e.g. ChatGPT) by focusing its window and pasting:

```json
"appTargets": [
  { "id": "chatgpt", "label": "ChatGPT", "process": "ChatGPT" }
]
```

Each entry needs an `id`, a `label`, and at least one window matcher — `process` (preferred) or an exact `title`. Optional `pasteFocusKeys` is a SendKeys string fired once before the paste, to move focus into the app's input box first.
</details>

### Hotkeys at a glance

| Key | Verb | What happens |
| --- | --- | --- |
| `Ctrl+Alt+D` | Dictate | Voice → polished text, pasted where you are |
| `Ctrl+Alt+H` | Herald | Voice → polished text, delivered to an agent pane |
| `Ctrl+Alt+S` | Capture | Screenshot the active window → deliver it |
| `Ctrl+Alt+C` | Relay | Clipboard (text / image / files) → deliver it |
| `Ctrl+Alt+J` | Jump | Go to the agent that most needs you |
| `Esc` | — | Cancel a recording, or undo a crop, or dismiss the picker |
| `←` / `→` | — | Arrow through your last ten captures / relays in the picker |

## Local development

```sh
npm start        # compile TypeScript, then launch Electron
npm test         # run the test suite
npm run typecheck  # type-check without building
```

Design references and extracted mascot assets live under `docs/design/`. Architecture decisions are recorded in `docs/adr/`, and the domain vocabulary — what exactly a *Capture*, a *Relay*, or a *Herald* means — lives in `CONTEXT.md`.

## Design principle

The joke makes the tool lovable, but it must never slow the user down. The mascot is delightful seasoning — not the meal. Whatever new hat the gentleman puts on, he stays out of your way while wearing it.
