import type { EligibleTarget } from "./herdr";

// App Targets (ChatGPT-as-target, 2026-07-17): a config-driven relay
// destination that is NOT a Herdr pane. MF focuses the app's window and pastes
// the payload (clipboard + Ctrl+V) — the very primitive Herald's "Paste here"
// already uses. Deliberately per-machine CONFIG, never source (mirrors
// project-anchors): Mistr Flow runs on machines with different apps installed,
// and MF learns no app semantics — each machine's config.json names its own.
// House pattern: this is a PURE module — validation + a pure mapper over plain
// data. Config I/O lives in config.ts, focus in appWindow.ts, delivery in
// appDeliver.ts, the row in overlay-renderer.js.

/** One config-owned app relay target: how to find its window + how the row reads. */
export interface AppTarget {
  /** Durable key: the picker target id becomes `app:<id>`; also the dedupe key. */
  readonly id: string;
  /** The row's human label (e.g. "ChatGPT"). */
  readonly label: string;
  /** Window process name to focus (e.g. "ChatGPT") — the primary matcher. */
  readonly process?: string;
  /** Exact window title to focus — a fallback matcher when process is absent/ambiguous. */
  readonly title?: string;
  /** A glyph id from the renderer's library (the WHERE channel). */
  readonly glyph?: string;
  /**
   * Optional SendKeys string fired once BEFORE the paste, to move focus into
   * the app's composer. Per-machine and tunable without a rebuild — different
   * apps need different composer-focus keystrokes, and some need none at all.
   */
  readonly pasteFocusKeys?: string;
}

/**
 * The app-target's matcher + presentation bag, carried on
 * {@link EligibleTarget.app}. Fields are nullable-but-total (null, not absent)
 * so every reader (the renderer, the focus helper) reads fixed keys rather than
 * probing for presence.
 */
export interface AppTargetView {
  readonly label: string;
  readonly process: string | null;
  readonly title: string | null;
  readonly glyph: string | null;
  readonly pasteFocusKeys: string | null;
}

const MAX_APP_TARGETS = 4;
const MAX_FIELD_LENGTH = 200;

/**
 * Validates the raw `appTargets` config value into usable targets. Mirrors
 * {@link normalizeProjectAnchors}'s posture: junk entries are dropped, never
 * fatal — a typo in config must not cost the picker itself. An entry needs a
 * usable `id` + `label` AND at least one window matcher (`process` or `title`),
 * or it could never be focused and is dropped.
 */
export function normalizeAppTargets(value: unknown): AppTarget[] {
  if (!Array.isArray(value)) return [];
  const result: AppTarget[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as {
      id?: unknown;
      label?: unknown;
      process?: unknown;
      title?: unknown;
      glyph?: unknown;
      pasteFocusKeys?: unknown;
    };
    if (typeof raw.id !== "string" || typeof raw.label !== "string") continue;

    const id = sanitizeId(raw.id);
    const label = raw.label.trim().slice(0, MAX_FIELD_LENGTH);
    if (!id || !label) continue;

    const process = optionalField(raw.process);
    const title = optionalField(raw.title);
    // No matcher ⇒ the window can never be found. Drop it, never keep a dud row.
    if (!process && !title) continue;

    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      label,
      ...(process ? { process } : {}),
      ...(title ? { title } : {}),
      ...(optionalField(raw.glyph) ? { glyph: optionalField(raw.glyph)! } : {}),
      ...(optionalField(raw.pasteFocusKeys)
        ? { pasteFocusKeys: optionalField(raw.pasteFocusKeys)! }
        : {}),
    });
    if (result.length >= MAX_APP_TARGETS) break;
  }
  return result;
}

/**
 * Projects an {@link AppTarget} into the picker's target currency. Pure and
 * unit-tested so main.ts stays thin. The pane fields are inert placeholders
 * (see {@link EligibleTarget.app}): `agentStatus: "idle"` keeps the closed
 * {@link AgentStatus} union intact without ever being read, and `agent: id` is
 * deliberately a name absent from the renderer's `AGENT_CAP_COLORS`, so the row
 * keeps the honest brass "unclaimed" keycap.
 */
export function appTargetToEligibleTarget(app: AppTarget): EligibleTarget {
  return {
    target: `app:${app.id}`,
    label: app.label,
    agentStatus: "idle",
    agent: app.id,
    cwd: null,
    kind: "app",
    app: {
      label: app.label,
      process: app.process ?? null,
      title: app.title ?? null,
      glyph: app.glyph ?? null,
      pasteFocusKeys: app.pasteFocusKeys ?? null,
    },
  };
}

/** Lowercase, keep only a safe id token, length-cap. */
function sanitizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, MAX_FIELD_LENGTH);
}

/** A trimmed, length-capped string, or undefined for anything unusable. */
function optionalField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, MAX_FIELD_LENGTH);
  return trimmed || undefined;
}
