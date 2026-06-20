/**
 * MistrFlowIcons.tsx
 * All Mistr Flow icons as named React components — inline SVG, zero deps.
 *
 * Usage:
 *   import { MistrFlowAvatar, DoneIcon, StateIndicatorIcon } from './MistrFlowIcons';
 *
 *   <MistrFlowAvatar size={32} />
 *   <DoneIcon size={20} />
 *   <StateIndicatorIcon state="done" size={18} />
 */

import React from 'react';
import type { MistrFlowState } from '../code/mistr-flow.types';

// ─── Shared props ─────────────────────────────────────────────────────────────

interface IconProps {
  /** Rendered size in px (square). Default: 32. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean | 'true' | 'false';
}

// ─── Colour constants ─────────────────────────────────────────────────────────

const INK        = '#2A241F';
const DARK_HAT   = '#1F1A17';
const HAT_DARK   = '#332B25';
const BRASS      = '#B8893C';
const FACE       = '#EBDCBE';
const CARD_CREAM = '#F8F1E1';
const SUCCESS    = '#1F8A5B';
const WARN_BG    = '#F3EAD6';

// ─── MistrFlowAvatar ──────────────────────────────────────────────────────────
/**
 * The mini avatar shown on the left side of every overlay card:
 * top hat + face + Pringles-style drooping moustache.
 * Transparent background — place on any surface.
 */
export const MistrFlowAvatar: React.FC<IconProps> = ({
  size = 32,
  className,
  style,
  'aria-hidden': ariaHidden = true,
}) => (
  <svg
    viewBox="0 0 40 40"
    width={size}
    height={size}
    className={className}
    style={style}
    aria-hidden={ariaHidden}
    xmlns="http://www.w3.org/2000/svg"
  >
    {/* Hat — brim oval (15° downward perspective) */}
    <ellipse cx="20" cy="21" rx="11" ry="2" fill={DARK_HAT} />
    {/* Crown */}
    <path
      d="M10,21 L8.8,9 Q8.8,7 11,7 L29,7 Q31.2,7 31.2,9 L30,21 Z"
      fill={INK}
    />
    {/* Crown top */}
    <ellipse cx="20" cy="7" rx="11.2" ry="2" fill={HAT_DARK} />
    {/* Brass band — curved bottom */}
    <path d="M9.5,15.5 L30.5,15.5 L30.5,18.5 Q20,19.8 9.5,18.5 Z" fill={BRASS} />
    {/* Face */}
    <circle cx="20" cy="29" r="6.5" fill={FACE} />
    {/* Moustache — two drooping lobes */}
    <path
      d="M20,30.5 C18.5,29.5 16,29.5 14.5,31 C13.5,32 13.5,34 14.5,35 C15.5,36 17.5,35.5 19,34.5 C19.5,34 19.8,33 20,32.5 C20.2,33 20.5,34 21,34.5 C22.5,35.5 24.5,36 25.5,35 C26.5,34 26.5,32 25.5,31 C24,29.5 21.5,29.5 20,30.5 Z"
      fill={INK}
    />
  </svg>
);

// ─── MistrFlowTrayIcon ────────────────────────────────────────────────────────
/**
 * Simplified tray/app icon: hat + moustache only, no face.
 * Cream on transparent — works against dark taskbars.
 * For Electron, use the tray-*.png files (PNG required on Windows).
 */
export const MistrFlowTrayIcon: React.FC<IconProps> = ({
  size = 32,
  className,
  style,
  'aria-hidden': ariaHidden = true,
}) => (
  <svg
    viewBox="0 0 32 32"
    width={size}
    height={size}
    className={className}
    style={style}
    aria-hidden={ariaHidden}
    xmlns="http://www.w3.org/2000/svg"
  >
    {/* Hat — brim */}
    <ellipse cx="16" cy="17" rx="12" ry="2.2" fill={FACE} />
    {/* Crown */}
    <path
      d="M8,17 L6.8,5 Q6.8,3 9,3 L23,3 Q25.2,3 25.2,5 L24,17 Z"
      fill={FACE}
    />
    {/* Band */}
    <rect x="7" y="11" width="18" height="2.5" fill={BRASS} />
    {/* Moustache */}
    <path
      d="M16,22.5 C14.5,21.5 12,21.5 10.5,23 C9.5,24 9.5,26 10.5,27 C11.5,28 13.5,27.5 15,26.5 C15.5,26 15.8,25 16,24.5 C16.2,25 16.5,26 17,26.5 C18.5,27.5 20.5,28 21.5,27 C22.5,26 22.5,24 21.5,23 C20,21.5 17.5,21.5 16,22.5 Z"
      fill={FACE}
    />
  </svg>
);

// ─── State indicator icons ─────────────────────────────────────────────────────
// These appear on the RIGHT side of the overlay card.
// They can also be used standalone — e.g. in window titles, notifications.

/**
 * Listening indicator: pulsing orange dot.
 * Rendered as a static dot — pulse is applied via CSS class `mf-indicator-dot`
 * in the overlay component. For static use, this is already correct.
 */
export const ListeningIcon: React.FC<IconProps> = ({
  size = 8, className, style, 'aria-hidden': ariaHidden = true,
}) => (
  <svg viewBox="0 0 8 8" width={size} height={size} className={className} style={style} aria-hidden={ariaHidden} xmlns="http://www.w3.org/2000/svg">
    <circle cx="4" cy="4" r="4" fill={BRASS} />
  </svg>
);

/**
 * Recording indicator: three waveform bars (static version).
 */
export const RecordingIcon: React.FC<IconProps> = ({
  size = 16, className, style, 'aria-hidden': ariaHidden = true,
}) => (
  <svg viewBox="0 0 14 14" width={size} height={size} className={className} style={style} aria-hidden={ariaHidden} xmlns="http://www.w3.org/2000/svg">
    <rect x="1"  y="8"  width="3" height="6"  rx="1.5" fill={BRASS} />
    <rect x="5.5" y="2" width="3" height="12" rx="1.5" fill={BRASS} />
    <rect x="10" y="6" width="3" height="8"  rx="1.5" fill={BRASS} />
  </svg>
);

/**
 * Processing indicator: a circular arc (static spinner silhouette).
 */
export const ProcessingIcon: React.FC<IconProps> = ({
  size = 14, className, style, 'aria-hidden': ariaHidden = true,
}) => (
  <svg viewBox="0 0 14 14" width={size} height={size} className={className} style={style} aria-hidden={ariaHidden} xmlns="http://www.w3.org/2000/svg">
    <circle cx="7" cy="7" r="5.5" fill="none" stroke="#E0D4BC" strokeWidth="2" />
    <path d="M7,1.5 A5.5,5.5 0 0,1 12.5,7" fill="none" stroke={BRASS} strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/**
 * Polishing indicator: a small four-point sparkle.
 */
export const PolishingIcon: React.FC<IconProps> = ({
  size = 14, className, style, 'aria-hidden': ariaHidden = true,
}) => (
  <svg viewBox="0 0 14 14" width={size} height={size} className={className} style={style} aria-hidden={ariaHidden} xmlns="http://www.w3.org/2000/svg">
    <path d="M7,1 L8,6 L13,7 L8,8 L7,13 L6,8 L1,7 L6,6 Z" fill={BRASS} />
  </svg>
);

/**
 * Done indicator: green circle with a checkmark.
 * Use in notifications, toast messages, history items.
 */
export const DoneIcon: React.FC<IconProps> = ({
  size = 18, className, style, 'aria-hidden': ariaHidden = true,
}) => (
  <svg viewBox="0 0 18 18" width={size} height={size} className={className} style={style} aria-hidden={ariaHidden} xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="9" r="9" fill={SUCCESS} />
    <path
      d="M4.5,9.5 L7.5,12.5 L13.5,6.5"
      fill="none"
      stroke={CARD_CREAM}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Error indicator: brass-ringed warning circle with exclamation mark.
 * Charming — not alarming. No red.
 */
export const ErrorIcon: React.FC<IconProps> = ({
  size = 18, className, style, 'aria-hidden': ariaHidden = true,
}) => (
  <svg viewBox="0 0 18 18" width={size} height={size} className={className} style={style} aria-hidden={ariaHidden} xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="9" r="8.25" fill={WARN_BG} stroke={BRASS} strokeWidth="1.5" />
    <rect x="8" y="5" width="2" height="5.5" rx="1" fill="#9A6F2E" />
    <circle cx="9" cy="13" r="1.1" fill="#9A6F2E" />
  </svg>
);

/**
 * Cancelled indicator: a small faded hat silhouette (ghost).
 * Use to show the session was discarded.
 */
export const CancelledIcon: React.FC<IconProps> = ({
  size = 18, className, style, 'aria-hidden': ariaHidden = true,
}) => (
  <svg viewBox="0 0 18 18" width={size} height={size} className={className} style={style} aria-hidden={ariaHidden} xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="9" cy="11" rx="7" ry="1.6" fill="#C8C0B4" />
    <path d="M4,11 L3.2,3.5 Q3.2,2 5,2 L13,2 Q14.8,2 14.8,3.5 L14,11 Z" fill="#C8C0B4" />
    <rect x="3.2" y="7" width="11.6" height="2" fill="#B0A898" />
  </svg>
);

// ─── Convenience: StateIndicatorIcon ─────────────────────────────────────────
/**
 * Returns the correct right-side indicator icon for any state.
 * Returns null for idle (no indicator shown).
 *
 * @example
 *   <StateIndicatorIcon state="done" size={18} />
 */
export const StateIndicatorIcon: React.FC<
  IconProps & { state: MistrFlowState }
> = ({ state, size = 18, ...rest }) => {
  switch (state) {
    case 'listening':  return <ListeningIcon   size={8}    {...rest} />;
    case 'recording':  return <RecordingIcon   size={size} {...rest} />;
    case 'processing': return <ProcessingIcon  size={size} {...rest} />;
    case 'polishing':  return <PolishingIcon   size={size} {...rest} />;
    case 'done':       return <DoneIcon        size={size} {...rest} />;
    case 'error':      return <ErrorIcon       size={size} {...rest} />;
    case 'cancelled':  return <CancelledIcon   size={size} {...rest} />;
    default:           return null;
  }
};

// ─── Re-export for convenience ────────────────────────────────────────────────
export type { IconProps };
