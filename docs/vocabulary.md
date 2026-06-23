# Private Vocabulary Support

Mistr Flow can bias Whisper transcription and Polish correction toward words and phrases you use often, reducing consistent mishearings.

## Privacy boundary

Your real vocabulary must **not** be committed to this public repository. Store it only in your local runtime config at `%APPDATA%\MistrFlow\config.json`. Do not paste real vocabulary into GitHub issue text, PR descriptions, or commit messages.

Vocabulary is sent to OpenAI with each dictation request — the same privacy boundary that already applies to your audio and transcript.

## Config schema

Add an optional `vocabulary` object to `%APPDATA%\MistrFlow\config.json`:

```json
{
  "openaiApiKey": "...",
  "vocabulary": {
    "enabled": true,
    "terms": ["ProjectZephyr", "ExampleCorp"],
    "phrases": ["agent memory service", "second brain"],
    "replacements": [
      { "wrong": "mister flow", "right": "Mistr Flow" },
      { "wrong": "clod code", "right": "Claude Code" }
    ]
  }
}
```

- **`terms`** — names, products, acronyms, usernames, project names. Passed to Whisper as spelling hints.
- **`phrases`** — multi-word concepts to preserve intact. Passed to Whisper as spelling hints.
- **`replacements`** — explicit likely mishearings. Applied by Polish only (not Whisper), since Polish sees text rather than audio.
- **`enabled`** — set to `false` to disable vocabulary without removing it. Defaults to enabled when the field is present.
- All arrays are optional. Empty or missing vocabulary preserves the current behavior.

## How it works

- Terms and phrases are sent to Whisper as a transcription `prompt`, biasing the model toward those spellings.
- All three fields are passed to Polish as correction context. Polish can fix spelling of intended terms and correct explicit mishearings, but the existing cleanup-only contract still applies — it will not remove, reorder, or rewrite content, and it will not introduce a vocabulary term unless the transcript appears to contain that spoken word.

## Troubleshooting

Start with a small list of high-value replacements (the words that constantly get mangled) rather than an exhaustive glossary. A few well-chosen entries are more reliable than hundreds.
