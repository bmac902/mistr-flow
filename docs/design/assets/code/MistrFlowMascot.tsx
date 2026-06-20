/**
 * MistrFlowMascot.tsx
 * Full-size animated mascot component (viewBox 160 × 185).
 * Driven entirely by the `state` prop — no internal state machine.
 *
 * Usage:
 *   import { MistrFlowMascot } from './mistr-flow';
 *   <MistrFlowMascot state={appState} width={240} />
 */

import React, { useCallback, useRef } from 'react';
import type { MistrFlowMascotProps, MistrFlowState } from './mistr-flow.types';
import { LOOPING_STATES } from './mistr-flow.types';
import './mistr-flow.css';

// ─── Hat ──────────────────────────────────────────────────────────────────────

const Hat: React.FC = () => (
  <g className="mf-hat">
    {/* Brim — oval seen from ~15° above */}
    <ellipse cx="62" cy="58" rx="26" ry="5" fill="#1F1A17" />
    {/* Crown */}
    <path
      d="M49,59 L47.5,39.5 Q47.5,37 51,37 L73,37 Q76.5,37 76.5,39.5 L75,59 Z"
      fill="#2A241F"
    />
    {/* Crown top */}
    <ellipse cx="62" cy="37" rx="14.5" ry="2.8" fill="#332B25" />
    {/* Brass band — curved bottom follows brim perspective */}
    <path
      d="M49.5,50.5 L74.5,50.5 L74.5,54.5 Q62,56.5 49.5,54.5 Z"
      fill="#B8893C"
    />
  </g>
);

// ─── Mascot SVG ───────────────────────────────────────────────────────────────

export const MistrFlowMascot: React.FC<MistrFlowMascotProps> = ({
  state = 'idle',
  width = 240,
  onAnimationComplete,
  className = '',
  style,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);

  const handleAnimationEnd = useCallback(
    (e: React.AnimationEvent<SVGSVGElement>) => {
      // Only fire callback for one-shot animations — not loops
      if (onAnimationComplete && !LOOPING_STATES.has(state)) {
        // Filter to the outermost animated element to avoid duplicate calls
        if (e.target === e.currentTarget || (e.target as Element).closest('.mf-body, .mf-cane, .mf-hat, .mf-figure')) {
          onAnimationComplete(state);
        }
      }
    },
    [state, onAnimationComplete],
  );

  const isRecording = state === 'recording';
  const isError = state === 'error';
  const isPolishing = state === 'polishing';

  const height = Math.round(width * (185 / 160));

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 160 185"
      width={width}
      height={height}
      className={`mf-mascot mf-state-${state} ${className}`}
      style={style}
      aria-hidden="true"
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Ground shadow */}
      <ellipse cx="62" cy="170" rx="38" ry="6" fill="rgba(0,0,0,0.35)" />

      {/* ── Microphone (static) ─────────────────────────────────────────── */}
      <g>
        <ellipse cx="120" cy="170" rx="13" ry="3.5" fill="#1A1613" />
        <rect x="118" y="120" width="4" height="50" fill="#4A4038" />
        <rect
          x="111" y="94" width="18" height="28" rx="9"
          fill="#2A241F" stroke="#B8893C" strokeWidth="1.5"
        />
        <line x1="114" y1="101" x2="126" y2="101" stroke="#B8893C" strokeWidth="1.1" />
        <line x1="114" y1="106" x2="126" y2="106" stroke="#B8893C" strokeWidth="1.1" />
        <line x1="114" y1="111" x2="126" y2="111" stroke="#B8893C" strokeWidth="1.1" />
      </g>

      {/* ── Sound waves (recording only) ─────────────────────────────────── */}
      {isRecording && (
        <g>
          <path
            d="M133,98 Q139,108 133,118"
            stroke="#D8B068" strokeWidth="2" fill="none"
            className="mf-wave mf-wave-1"
          />
          <path
            d="M139,93 Q148,108 139,123"
            stroke="#B8893C" strokeWidth="2" fill="none"
            className="mf-wave mf-wave-2"
          />
        </g>
      )}

      {/* ── Sentence ribbon (polishing only) ─────────────────────────────── */}
      {isPolishing && (
        <g>
          <rect
            x="92" y="120" width="56" height="26" rx="3"
            fill="#F4ECD9" transform="rotate(-6 120 133)"
          />
          <g transform="rotate(-6 120 133)">
            {/* Messy words (fade out) */}
            <g className="mf-words-messy">
              <rect x="98" y="127" width="30" height="2.4" rx="1.2" fill="#C9BCA0" />
              <rect x="98" y="133" width="40" height="2.4" rx="1.2" fill="#C9BCA0" />
              <rect x="98" y="139" width="22" height="2.4" rx="1.2" fill="#C9BCA0" />
            </g>
            {/* Clean words (fade in) */}
            <g className="mf-words-clean" style={{ opacity: 0 }}>
              <rect x="98" y="127" width="34" height="2.6" rx="1.3" fill="#2A241F" />
              <rect x="98" y="133" width="26" height="2.6" rx="1.3" fill="#2A241F" />
            </g>
          </g>
        </g>
      )}

      {/* ── Figure group (exits on cancelled) ──────────────────────────────── */}
      <g className="mf-figure">

        {/* Cane */}
        <g className="mf-cane">
          <line
            x1="89" y1="110" x2="99" y2="164"
            stroke="#463C34" strokeWidth="3.2" strokeLinecap="round"
          />
          <circle cx="88" cy="109" r="4.2" fill="#B8893C" />
        </g>

        {/* Body group */}
        <g className="mf-body">

          {/* Tail coat */}
          <path d="M47,150 L50,99 Q62,91 74,99 L77,150 Z" fill="#2A241F" />
          {/* Shirt front */}
          <path d="M56,98 L68,98 L65,142 L59,142 Z" fill="#F4ECD9" />
          {/* Shirt buttons */}
          <circle cx="62" cy="116" r="1.5" fill="#B8893C" />
          <circle cx="62" cy="126" r="1.5" fill="#B8893C" />
          {/* Bowtie */}
          <path
            d="M55.5,93.5 L62,98 L55.5,102.5 Z M68.5,93.5 L62,98 L68.5,102.5 Z"
            fill="#B8893C"
          />
          <circle cx="62" cy="98" r="2.1" fill="#9A6F2E" />

          {/* Arm + glove (brushes during polishing) */}
          <g className="mf-arm">
            <path
              d="M74,100 Q84,104 88,110"
              stroke="#2A241F" strokeWidth="7" fill="none" strokeLinecap="round"
            />
            <circle cx="88" cy="111" r="4.6" fill="#F4ECD9" stroke="#2A241F" strokeWidth="1" />
          </g>

          {/* Head */}
          <circle cx="62" cy="73" r="18" fill="#EBDCBE" stroke="#2A241F" strokeWidth="1.4" />

          {/* Eyes */}
          <g className="mf-eyes">
            <circle cx="54" cy="70" r="2.3" fill="#2A241F" />
            <circle cx="68" cy="70" r="2.3" fill="#2A241F" />
          </g>

          {/* Brows — normal */}
          {!isError && (
            <g>
              <rect x="49.5" y="63.5" width="9" height="2.6" rx="1.3" fill="#2A241F" />
              <rect x="65.5" y="63.5" width="9" height="2.6" rx="1.3" fill="#2A241F" />
            </g>
          )}

          {/* Brows — worried (error only) */}
          {isError && (
            <g className="mf-brows">
              <path
                d="M49,62 Q54,58 59,61"
                stroke="#2A241F" strokeWidth="2.6" fill="none" strokeLinecap="round"
              />
              <path
                d="M65,61 Q70,58 75,62"
                stroke="#2A241F" strokeWidth="2.6" fill="none" strokeLinecap="round"
              />
            </g>
          )}

          {/* Nose */}
          <circle cx="62" cy="76" r="1.5" fill="#C8A877" />

          {/* Moustache — Pringles-style drooping lobes */}
          <path
            className="mf-moustache"
            d="M62,80.5 C59.5,79 55,79 51,81 C48,82.5 48,85.5 51,86.5 C53.5,87.5 57.5,86.5 60,85 C61,84 61.5,82.5 62,82 C62.5,82.5 63,84 64,85 C66.5,86.5 70.5,87.5 73,86.5 C76,85.5 76,82.5 73,81 C69,79 64.5,79 62,80.5 Z"
            fill="#2A241F"
          />

          {/* Hat */}
          <Hat />

        </g>
      </g>
    </svg>
  );
};

export default MistrFlowMascot;
