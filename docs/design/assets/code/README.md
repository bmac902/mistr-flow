# Mistr Flow — Component Package

React + TypeScript visual package for the Mistr Flow dictation overlay.
Targets **Electron + React + TypeScript** with no external animation libraries.

---

## Files

| File | Purpose |
|---|---|
| `mistr-flow.types.ts` | `MistrFlowState` union, `STATUS_COPY`, prop interfaces, design tokens |
| `mistr-flow.css` | All `@keyframes` + state-driven animation classes + overlay card styles |
| `MistrFlowMascot.tsx` | Full-size animated mascot (viewBox 160 × 185) |
| `MistrFlowOverlay.tsx` | Production overlay card for the transparent Electron window |
| `index.ts` | Barrel — import from here |

---

## Setup

### 1. Copy the folder into your src

```
src/
  renderer/
    components/
      mistr-flow/           ← drop the whole folder here
        index.ts
        mistr-flow.types.ts
        mistr-flow.css
        MistrFlowMascot.tsx
        MistrFlowOverlay.tsx
```

### 2. Load the font (optional but recommended)

Add to your renderer's `index.html` or global CSS:

```html
<link
  rel="preconnect"
  href="https://fonts.googleapis.com"
/>
<link
  href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap"
  rel="stylesheet"
/>
```

The components fall back to `system-ui` if the font is unavailable.

---

## Overlay card (Electron transparent window)

### Electron main process

```typescript
const overlayWin = new BrowserWindow({
  width: 280,
  height: 56,
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  webPreferences: { nodeIntegration: true, contextIsolation: false },
});

// Click-through — your state machine handles all interaction
overlayWin.setIgnoreMouseEvents(true);

// Anchor to bottom-right
const { width, height } = screen.getPrimaryDisplay().workAreaSize;
overlayWin.setPosition(width - 296, height - 72);
```

### Renderer

```tsx
// renderer/OverlayApp.tsx
import React from 'react';
import { MistrFlowOverlay } from './mistr-flow';
import type { MistrFlowState } from './mistr-flow';

// Your state machine sends the current state via IPC or a shared store.
const App: React.FC<{ state: MistrFlowState }> = ({ state }) => (
  <MistrFlowOverlay
    state={state}
    onAnimationComplete={(s) => {
      // Example: auto-advance from done → idle after animation
      if (s === 'done') window.electronAPI.resetState();
    }}
  />
);
```

---

## Full-size mascot (storyboard / onboarding / debug view)

```tsx
import { MistrFlowMascot } from './mistr-flow';

<MistrFlowMascot
  state="recording"
  width={320}
  onAnimationComplete={(s) => console.log('animation done:', s)}
/>
```

---

## State type

```typescript
type MistrFlowState =
  | 'idle'        // breathes, blinks — loops
  | 'listening'   // tips hat, leans — 380 ms one-shot
  | 'recording'   // moustache wiggles, sound waves — loops
  | 'processing'  // cane twirl — 560 ms one-shot
  | 'polishing'   // lint brush, text reveal — 680 ms one-shot
  | 'done'        // bow + cane flourish — 520 ms one-shot
  | 'error'       // hat falls — 460 ms one-shot
  | 'cancelled';  // exits stage-left — 640 ms one-shot
```

---

## Status copy

```typescript
import { STATUS_COPY } from './mistr-flow';

console.log(STATUS_COPY['done']); // "Pasted, sir."
```

Override per-render with the `statusText` prop.

---

## Reduced motion

All animations are stripped under `prefers-reduced-motion: reduce`.
State cross-fades remain at 120 ms. No code changes required in your app.

---

## Design tokens

```typescript
import { MF_TOKENS } from './mistr-flow';

// MF_TOKENS.brass === '#B8893C'
// MF_TOKENS.ink   === '#2A241F'
// etc.
```

---

## Animation durations (for scheduling)

```typescript
import { ANIMATION_DURATION_MS } from './mistr-flow';

// After triggering 'done', advance to 'idle' once animation finishes:
setTimeout(() => setState('idle'), ANIMATION_DURATION_MS['done']); // 520 ms
// Or use onAnimationComplete for a DOM-event-driven approach.
```

---

## Agent-testable acceptance criteria

- [ ] `MistrFlowOverlay` renders without errors for all 8 states
- [ ] `MistrFlowMascot` renders without errors for all 8 states
- [ ] `STATUS_COPY` has exactly 8 entries matching `MistrFlowState`
- [ ] `mistr-flow.css` contains `@keyframes mf-breathe` and `prefers-reduced-motion` block
- [ ] `onAnimationComplete` is NOT called for `idle` or `recording` (looping states)
- [ ] Snapshot / DOM tests pass for each state class combination

## Human verification (Windows)

- [ ] Open app → overlay feels charming, not annoying
- [ ] Overlay never steals focus or interrupts typing
- [ ] Moustache reads as two distinct drooping lobes
- [ ] Top hat brim oval is visible (15° downward perspective)
- [ ] Tray icon reads at 16 px (hat silhouette + moustache)
- [ ] All 8 states transition smoothly
