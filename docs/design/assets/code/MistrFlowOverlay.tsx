/**
 * MistrFlowOverlay.tsx
 * Production overlay card for the Electron transparent window.
 *
 * The Electron window should be:
 *   new BrowserWindow({ transparent: true, frame: false, alwaysOnTop: true })
 * Click-through is handled at the window level via win.setIgnoreMouseEvents(true).
 *
 * This component renders a single 280 × auto card, meant to be the sole
 * content of the frameless window. It does not impose a page background.
 *
 * Usage:
 *   import { MistrFlowOverlay } from './mistr-flow';
 *   <MistrFlowOverlay state={appState} onAnimationComplete={onDone} />
 */

import React, { useEffect, useRef } from 'react';
import type { MistrFlowOverlayProps, MistrFlowState } from './mistr-flow.types';
import { ANIMATION_DURATION_MS, STATUS_COPY, LOOPING_STATES } from './mistr-flow.types';
import './mistr-flow.css';

// ─── Mini avatar (40 × 40 viewBox, hat + face + moustache) ────────────────────

const MiniAvatar: React.FC<{ state: MistrFlowState }> = ({ state }) => (
  <svg
    viewBox="0 0 40 40"
    width="32"
    height="32"
    aria-hidden="true"
    className={`mf-mascot mf-state-${state}`}
  >
    {/* Hat brim */}
    <ellipse cx="20" cy="21" rx="11" ry="2" fill="#1F1A17" />
    {/* Crown */}
    <path
      d="M10,21 L8.8,9 Q8.8,7 11,7 L29,7 Q31.2,7 31.2,9 L30,21 Z"
      fill="#2A241F"
    />
    {/* Crown top */}
    <ellipse cx="20" cy="7" rx="11.2" ry="2" fill="#332B25" />
    {/* Band */}
    <path
      d="M9.5,15.5 L30.5,15.5 L30.5,18.5 Q20,19.8 9.5,18.5 Z"
      fill="#B8893C"
    />
    {/* Face */}
    <circle cx="20" cy="29" r="6.5" fill="#EBDCBE" />
    {/* Moustache */}
    <path
      d="M20,30.5 C18.5,29.5 16,29.5 14.5,31 C13.5,32 13.5,34 14.5,35 C15.5,36 17.5,35.5 19,34.5 C19.5,34 19.8,33 20,32.5 C20.2,33 20.5,34 21,34.5 C22.5,35.5 24.5,36 25.5,35 C26.5,34 26.5,32 25.5,31 C24,29.5 21.5,29.5 20,30.5 Z"
      fill="#2A241F"
    />
  </svg>
);

// ─── State indicator ──────────────────────────────────────────────────────────

const Indicator: React.FC<{ state: MistrFlowState }> = ({ state }) => {
  switch (state) {
    case 'listening':
      return <span className="mf-indicator-dot" aria-hidden="true" />;

    case 'recording':
      return (
        <span className="mf-indicator-bars" aria-hidden="true">
          <span /><span /><span />
        </span>
      );

    case 'processing':
      return <span className="mf-indicator-spinner" aria-hidden="true" />;

    case 'done':
      return (
        <span className="mf-indicator-check" aria-hidden="true">
          <svg
            viewBox="0 0 24 24" width="11" height="11"
            fill="none" stroke="#F4ECD9"
            strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
      );

    case 'error':
      return (
        <span className="mf-indicator-warn" aria-hidden="true">!</span>
      );

    default:
      return null;
  }
};

// ─── Overlay card ─────────────────────────────────────────────────────────────

export const MistrFlowOverlay: React.FC<MistrFlowOverlayProps> = ({
  state = 'idle',
  statusText,
  onAnimationComplete,
  className = '',
  style,
}) => {
  const completedStateRef = useRef<MistrFlowState | null>(null);

  useEffect(() => {
    completedStateRef.current = null;
  }, [state]);

  useEffect(() => {
    if (!onAnimationComplete || LOOPING_STATES.has(state)) return;
    if (completedStateRef.current === state) return;

    const durationMs = ANIMATION_DURATION_MS[state];
    if (!durationMs) return;

    const timeoutId = window.setTimeout(() => {
      if (completedStateRef.current === state) return;
      completedStateRef.current = state;
      onAnimationComplete(state);
    }, durationMs);

    return () => window.clearTimeout(timeoutId);
  }, [state, onAnimationComplete]);

  const copy = statusText ?? STATUS_COPY[state];

  return (
    <div
      className={`mf-overlay mf-state-${state} ${className}`}
      style={style}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="mf-overlay-avatar">
        <MiniAvatar state={state} />
      </div>

      <span className="mf-overlay-text">{copy}</span>

      <div className="mf-overlay-indicator">
        <Indicator state={state} />
      </div>
    </div>
  );
};

export default MistrFlowOverlay;
