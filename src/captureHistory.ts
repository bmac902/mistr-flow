// The pure bounded ring behind capture history (issue #94, PRD via #93-#96).
//
// House pattern, in the shape of fleetState / clipboardSource: no `fs`, no
// Electron, no timers, no `Date.now()`. It is a generic ring over an entry
// type because Capture holds a `CaptureArtifact` and Relay holds a clipboard
// payload, and both walk the same last-N history with the same arrow keys. The
// only entry-shaped knowledge the ring needs — how many bytes an entry costs
// and which file paths it references — is injected as two accessors, so the
// ring itself stays entirely value-agnostic.
//
// Ordering convention: index 0 is the OLDEST live entry, the last index is the
// NEWEST. The cursor is an index into that array; pushing appends a newest and
// parks the cursor on it, arrowing walks toward 0 (older) or the end (newer),
// both clamping at the ends — no wraparound, because a wrap is disorienting
// when you cannot see the whole list.

/** How many entries a ring holds before evicting oldest-first. */
export const DEFAULT_MAX_ENTRIES = 10;

export interface CaptureHistoryOptions<T> {
  /** Max entry count; exceeding it evicts oldest-first. Defaults to 10. */
  readonly maxEntries?: number;
  /**
   * Max cumulative byte budget across live entries; exceeding it evicts
   * oldest-first until the ring fits. Byte-bounding matters because clipboard
   * images run to tens of MB and a count-only cap would let ten of them balloon
   * memory. A single entry larger than the whole budget is still kept as the
   * sole entry rather than evicting itself into emptiness.
   */
  readonly maxBytes: number;
  /** Byte cost of an entry, summed against {@link maxBytes}. */
  readonly sizeOf: (entry: T) => number;
  /**
   * Every file path an entry references. Feeds {@link CaptureHistory.retainedPaths}
   * — a file stays on disk (via #93's `isRetained`) exactly as long as the ring
   * can still reach it. Both a live entry's current value and its pre-crop
   * original count as reachable.
   */
  readonly pathsOf: (entry: T) => readonly string[];
}

export interface CaptureHistory<T> {
  /**
   * Insert `entry` at the newest position and park the cursor on it — pushing
   * while parked on an older entry resets the cursor to the freshly-pushed one.
   * Evicts oldest-first until the ring fits both bounds.
   */
  push(entry: T): void;
  /** Step the cursor one entry older, clamping at the oldest. */
  older(): void;
  /** Step the cursor one entry newer, clamping at the newest. */
  newer(): void;
  /**
   * Replace the current entry's value in place, for cropping. Does not reorder
   * the ring, push, or move the cursor — a crop mutates the entry you are
   * standing on, so arrowing away and back preserves it. The entry's pre-crop
   * original is untouched, so Esc's two-stage undo still has a target.
   */
  replaceCurrent(entry: T): void;
  /** The entry at the cursor, or null on an empty ring. */
  readonly current: T | null;
  /**
   * The pre-crop original of the entry at the cursor, or null on an empty ring.
   * Equal to {@link current} until the entry is replaced.
   */
  readonly currentOriginal: T | null;
  /** Number of live entries. */
  readonly length: number;
  /** Cursor index (0 = oldest), or -1 on an empty ring. */
  readonly cursorIndex: number;
  /**
   * Every file path referenced by every live entry — current value and pre-crop
   * original alike. Evicting an entry drops its paths from this set, which is
   * what lets #93's sweep reclaim them.
   */
  retainedPaths(): Set<string>;
}

interface Slot<T> {
  /** The live value — mutated in place by a crop. */
  current: T;
  /** The value as first pushed, retained for Esc's undo. */
  readonly original: T;
}

export function createCaptureHistory<T>(
  options: CaptureHistoryOptions<T>,
): CaptureHistory<T> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes;
  const sizeOf = options.sizeOf;
  const pathsOf = options.pathsOf;

  const slots: Array<Slot<T>> = [];
  // -1 is the empty-ring cursor; any push moves it onto a real entry.
  let cursor = -1;

  function totalBytes(): number {
    let sum = 0;
    for (const slot of slots) {
      sum += sizeOf(slot.current);
    }
    return sum;
  }

  function evictToFit(): void {
    // Evict oldest-first (front of the array) while either bound is busted, but
    // never below a single entry — an entry bigger than the whole budget is
    // still kept as the sole survivor rather than evicting itself away.
    while (
      slots.length > 1 &&
      (slots.length > maxEntries || totalBytes() > maxBytes)
    ) {
      slots.shift();
      // Every remaining index shifted down by one. Decrementing the cursor in
      // lockstep keeps it on the same logical entry when that entry survives,
      // and lands it on the new oldest (index 0) when the entry it stood on was
      // the one evicted — so the cursor is never left dangling.
      cursor = Math.max(0, cursor - 1);
    }
  }

  return {
    push(entry) {
      slots.push({ current: entry, original: entry });
      cursor = slots.length - 1;
      evictToFit();
    },

    older() {
      if (cursor > 0) cursor -= 1;
    },

    newer() {
      if (cursor >= 0 && cursor < slots.length - 1) cursor += 1;
    },

    replaceCurrent(entry) {
      if (cursor < 0) return;
      slots[cursor].current = entry;
    },

    get current() {
      return cursor < 0 ? null : slots[cursor].current;
    },

    get currentOriginal() {
      return cursor < 0 ? null : slots[cursor].original;
    },

    get length() {
      return slots.length;
    },

    get cursorIndex() {
      return cursor;
    },

    retainedPaths() {
      const paths = new Set<string>();
      for (const slot of slots) {
        for (const p of pathsOf(slot.current)) paths.add(p);
        for (const p of pathsOf(slot.original)) paths.add(p);
      }
      return paths;
    },
  };
}
