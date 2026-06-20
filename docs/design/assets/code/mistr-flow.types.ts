/**
 * mistr-flow.types.ts
 * TypeScript types, status-copy map, and prop interfaces for Mistr Flow.
 */

import type { CSSProperties } from 'react';

// ─── State ────────────────────────────────────────────────────────────────────

/** All eight mascot / overlay states. Your state machine drives this. */
export type MistrFlowState =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'processing'
  | 'polishing'
  | 'done'
  | 'error'
  | 'cancelled';

// ─── Status copy ──────────────────────────────────────────────────────────────

/** Canonical status-bar copy for each state. Override via the statusText prop. */
export const STATUS_COPY: Record<MistrFlowState, string> = {
  idle:       'Ready when you are, sir.',
  listening:  'Listening\u2026',
  recording:  'Go on, I\u2019m taking notes\u2026',
  processing: 'Tidying your ramble\u2026',
  polishing:  'Ahem. Much better\u2026',
  done:       'Pasted, sir.',
  error:      'Mistr Flow tripped over the microphone.',
  cancelled:  'Very well. We shall pretend that never happened.',
};

// ─── State metadata ───────────────────────────────────────────────────────────

/** States whose animations loop indefinitely (no onAnimationComplete fired). */
export const LOOPING_STATES = new Set<MistrFlowState>(['idle', 'recording']);

/**
 * One-shot animation durations in ms, matching the design spec.
 * Useful for scheduling state transitions from the calling code.
 */
export const ANIMATION_DURATION_MS: Record<MistrFlowState, number> = {
  idle:       0,    // loops — no fixed duration
  listening:  380,
  recording:  0,    // loops — no fixed duration
  processing: 560,
  polishing:  680,
  done:       520,
  error:      460,
  cancelled:  640,
};

// ─── Design tokens ────────────────────────────────────────────────────────────

/** Core colour palette — match your Tailwind / CSS variables if you have them. */
export const MF_TOKENS = {
  cream:      '#EBE1CD',
  cardCream:  '#F8F1E1',
  stage:      '#3D3028',
  ink:        '#2A241F',
  charcoal:   '#6B5E4C',
  brass:      '#B8893C',
  brassLight: '#D8B068',
  warmWhite:  '#F4ECD9',
  face:       '#EBDCBE',
  success:    '#1F8A5B',
  border:     '#E0D4BC',
} as const;

// ─── Component props ──────────────────────────────────────────────────────────

export interface MistrFlowOverlayProps {
  /** Current state — your state machine sets this. Default: 'idle'. */
  state?: MistrFlowState;
  /** Override status-bar copy for this render. */
  statusText?: string;
  /**
   * Called once a one-shot animation finishes.
   * Not called for looping states (idle, recording).
   */
  onAnimationComplete?: (state: MistrFlowState) => void;
  className?: string;
  style?: CSSProperties;
}

export interface MistrFlowMascotProps {
  /** Current state. Default: 'idle'. */
  state?: MistrFlowState;
  /**
   * Render width in px — height scales proportionally (viewBox 160 × 185).
   * Default: 240.
   */
  width?: number;
  /** Called once a one-shot animation finishes. */
  onAnimationComplete?: (state: MistrFlowState) => void;
  className?: string;
  style?: CSSProperties;
}
