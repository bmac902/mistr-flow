// Project Anchors (idea grilled 2026-07-17): the picker rows' WHERE channel.
// A pane's cwd resolves to a small named glyph — "you stop thinking in paths,
// you think in projects" — while the agent-colored digit keycap is the WHO
// channel and the status text stays the WHAT. Three channels, none competing.
//
// The mapping is deliberately per-machine CONFIG, never source: Mistr Flow
// runs on two machines with different project sets (and MF learns no project
// semantics — CONTEXT.md). The glyph *library* ships in the renderer so a
// `git pull` carries the capability; each machine's config.json names its own
// projects. House pattern: this is a PURE module — validation + longest-prefix
// resolution over plain data; config I/O lives in config.ts, rendering in
// overlay-renderer.js.

/** One config-owned mapping: a path prefix worth a name and a glyph. */
export interface ProjectAnchor {
  /** Windows path prefix, matched case-insensitively at a path boundary. */
  readonly prefix: string;
  /** The friendly project name the row shows instead of the raw path. */
  readonly name: string;
  /** A glyph id from the renderer's library (e.g. "tophat", "note"). */
  readonly glyph: string;
}

const MAX_ANCHORS = 100;
const MAX_FIELD_LENGTH = 200;

/**
 * Validates the raw `projectAnchors` config value into usable anchors.
 * Mirrors the vocabulary reader's posture: junk entries are dropped, never
 * fatal — a typo in config must not cost the picker itself.
 */
export function normalizeProjectAnchors(value: unknown): ProjectAnchor[] {
  if (!Array.isArray(value)) return [];
  const result: ProjectAnchor[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { prefix, name, glyph } = item as {
      prefix?: unknown;
      name?: unknown;
      glyph?: unknown;
    };
    if (typeof prefix !== "string" || typeof name !== "string" || typeof glyph !== "string") {
      continue;
    }
    const p = prefix.trim().slice(0, MAX_FIELD_LENGTH);
    const n = name.trim().slice(0, MAX_FIELD_LENGTH);
    const g = glyph.trim().slice(0, MAX_FIELD_LENGTH);
    if (!p || !n || !g) continue;
    const key = normalizePath(p);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ prefix: p, name: n, glyph: g });
    if (result.length >= MAX_ANCHORS) break;
  }
  return result;
}

/**
 * Resolves a pane's cwd to its Project Anchor: longest matching prefix wins
 * (so `…\hermes` and `…\hermes\scratch` can coexist and the deeper one takes
 * its subfolders). Matching is case-insensitive, separator-agnostic, and
 * bound to path boundaries — `C:\dev\mistr` never claims `C:\dev\mistr-flow`.
 */
export function resolveProjectAnchor(
  cwd: string | null | undefined,
  anchors: readonly ProjectAnchor[],
): ProjectAnchor | null {
  if (!cwd) return null;
  const path = normalizePath(cwd);

  let best: ProjectAnchor | null = null;
  let bestLength = -1;
  for (const anchor of anchors) {
    const prefix = normalizePath(anchor.prefix);
    if (!prefix) continue;
    const matches = path === prefix || path.startsWith(prefix + "\\");
    if (matches && prefix.length > bestLength) {
      best = anchor;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Lowercase, forward slashes to backslashes, trailing separators stripped. */
function normalizePath(value: string): string {
  let normalized = value.trim().toLowerCase().replace(/\//g, "\\");
  while (normalized.endsWith("\\")) normalized = normalized.slice(0, -1);
  return normalized;
}
