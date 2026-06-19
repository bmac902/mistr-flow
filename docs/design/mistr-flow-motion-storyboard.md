# Mistr Flow — Motion & Design Storyboard

> **Tagline:** Dictate messy. Paste clean.
>
> Design reference for the Mistr Flow desktop dictation utility. This is a
> **design artifact**, not production code. Implement it in small, testable
> slices (see *Implementation notes* at the bottom).

Interactive reference: [`assets/mistr-flow-storyboard.html`](assets/mistr-flow-storyboard.html)
(open in a browser — the mascot animates per state).

---

## Governing principle

The joke makes the tool lovable, but it must **never slow the user down.**
The mascot is delightful seasoning, not the meal. Every animation is fast
(< ~800 ms) except *Recording*, which loops gently while the user speaks.

---

## What Mistr Flow is

A tiny Windows dictation utility. Core loop:

```
press hotkey → speak messy → transcribe → LLM cleans it → paste clean text
```

No voice control, no command grammar, no SaaS bloat. Just a tiny gentleman
who tidies your rambling.

---

## Mascot

Mistr Flow is a tiny vaudeville butler / stage-magician hybrid for dictated text —
ridiculous, but competent.

- short-crown **top hat** with a curled brim and a brass band
- **moustache** (handlebar)
- **tuxedo** with a brass **bowtie**
- **cane**
- old-fashioned **ribbon microphone** (his stage)
- expressive brows + eyes
- excessive dignity for such a small utility

Built entirely from simple primitives (circles, ellipses, two short curves) so he
stays consistent across states **and** reads at tray-icon sizes (16/24/32 px).
Not a robot, not a generic AI mascot, not corporate.

---

## Visual system

| Token | Value | Use |
|---|---|---|
| Cream (board) | `#EBE1CD` | page background |
| Card cream | `#F8F1E1` | overlay cards, panels |
| Stage | `#221D19` | dark “stage” behind the mascot |
| Ink | `#2A241F` | figure + primary text |
| Warm charcoal | `#6B5E4C` | secondary text |
| Brass | `#B8893C` (light `#D8B068`) | single accent — band, bowtie, ticks |
| Warm white | `#F4ECD9` | shirt, glove, status-card mini avatar |
| Face | `#EBDCBE` | mascot face fill |
| Success | `#1F8A5B` | “Pasted, sir.” confirmation only |
| Border (on cream) | `#E0D4BC` | hairlines |

**Type**

- **Playfair Display** (700/800) — brand wordmark + state names
- **Space Grotesk** (400–700) — UI + status copy
- **Space Mono** (400/700) — timing & spec annotations, kickers

**Stage feel:** a soft warm spotlight glow behind the mascot
(`radial-gradient` of brass at ~16–20% opacity over `#221D19`). No SaaS gradients,
no glassmorphism, no fake dashboards.

---

## Status overlay

A small card that **never steals focus**.

- size ≈ **280 × 56 px**, **12 px** corner radius
- warm cream `#F8F1E1`, 1 px `#E0D4BC` border, soft shadow `0 6px 18px rgba(0,0,0,.28)`
- contents: ~26 px mascot mini-avatar · status text (Space Grotesk) · optional state indicator (dot / waveform / check)
- **anchors bottom-right** of the screen by default; can **follow the caret** on demand
- click-through; must never grab keyboard focus or interrupt typing

---

## States

Each state = one mascot pose + status text + motion. Durations below are the
**real one-shot** values (the interactive board loops them for preview).

### 01 · Idle
- **Status:** “Ready when you are, sir.”
- **Motion:** leans on his cane; slow shoulder breathe; occasional blink.
- **Timing:** breathe `3.8s ease-in-out` (loop). Nothing demands attention.

### 02 · Listening
- **Status:** “Listening…”
- **Motion:** tips the top hat and leans an inch toward the mic, then settles. No bounce.
- **Timing:** `380ms cubic-bezier(.2,.8,.2,1)`

### 03 · Recording
- **Status:** “Go on, I’m taking notes…”
- **Motion:** moustache flutter; sound-wave ticks pulse off the mic; gentle head nod.
- **Timing:** moustache `1.1s` loop · waves `1.4s` loop (the one state that loops while active).

### 04 · Processing
- **Status:** “Tidying your ramble…”
- **Motion:** quick cane twirl with a faint dashed brass flourish around it. Quick and a little funny.
- **Timing:** `560ms cubic-bezier(.45,0,.55,1)`

### 05 · Polishing
- **Status:** “Ahem. Much better…”
- **Motion:** brushes lint off a sentence ribbon; messy words fade out as clean ones resolve in.
- **Timing:** `680ms ease-in-out`

### 06 · Done
- **Status:** “Pasted, sir.”
- **Motion:** crisp bow — top hat doffed, cane flourished; the pasted-clean confirmation pops in beneath.
- **Timing:** bow `520ms cubic-bezier(.34,1.56,.64,1)` (slight overshoot); confirmation pops after. Satisfying, never slow.

### 07 · Error
- **Status:** “Mistr Flow tripped over the microphone.”
- **Motion:** top hat pops off and lands slightly askew; brows lift in mild horror. Charming, **not alarming** — no red, no shake.
- **Timing:** `460ms cubic-bezier(.5,0,.75,0)`

### 08 · Cancelled
- **Status:** “Very well. We shall pretend that never happened.”
- **Motion:** exits stage-left, cane in hand, top hat dignity intact, then fades.
- **Timing:** `640ms cubic-bezier(.4,0,1,1)` (ease-in / accelerate off)

---

## Tray icon

Top hat **and** moustache, nothing more. Cream silhouette on an ink tile.

- tested at **32 / 24 / 16 px**
- below 24 px the face drops away — the **top-hat silhouette, brass band, and moustache must survive**
- monochrome so it reads on any taskbar

---

## Reduced motion

Under `prefers-reduced-motion`:

- no twirl, no wiggle, no bow, no hat-fall
- states **cross-fade in ~120 ms**; status text swaps instantly
- sound-waves collapse to a **static three-dot glyph**
- Mistr Flow holds one composed idle pose throughout
- **the tool stays exactly as fast**

---

## Implementation notes (for coding agents)

Build in small, testable slices. Do **not** make “visually verify the animated
desktop overlay” a ready-for-agent acceptance criterion — split it:

**Agent-testable**
- files / components exist
- design tokens (palette, overlay dimensions, status-copy constants) defined
- state → CSS-class / animation mappings exist
- `prefers-reduced-motion` styles exist
- snapshot / DOM tests pass

**Human verification (Windows)**
- overlay feels charming, not annoying
- overlay never steals focus / interrupts typing
- tray icon reads at small size

Suggested slice order: (1) design tokens, no animation → (2) text-only overlay
component rendering current state → (3) static mascot SVG + tray icon (16/24/32
snapshots) → (4) per-state CSS animations honouring reduced-motion.
