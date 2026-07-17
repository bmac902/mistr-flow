import type { EligibleTarget, HerdrQueryResult } from "./herdr";
import { MAX_ELIGIBLE_TARGETS } from "./herdr";

// The picker's target composition (ChatGPT-as-target, 2026-07-17): merges the
// live Herdr panes with the per-machine, config-driven app targets into the one
// digit-slotted list the picker renders. PURE — no I/O, no Electron — so the
// two load-bearing rules below are unit-tested without a running app:
//
//   1. App targets SURVIVE a Herdr-down poll. They are not panes, so an
//      unreachable Herdr must not hide them — and, crucially, must not unmark an
//      app Last Target's again-row: the session reconciles the again-row against
//      THIS result (captureSession.ts), and a non-"targets" result would unmark
//      it. Synthesize a targets result only when apps actually exist, so a
//      zero-config machine keeps today's exact behaviour (the Herdr failure
//      toast rides the non-"targets" branch — "Clipboard only, sir.").
//
//   2. App targets never squeeze panes off the low digits, but a full fleet
//      never squeezes out the always-available app either: panes keep digits
//      2.. and apps append after, yet the shared 8-slot digit space is RESERVED
//      for the apps first, so an 8th pane is displaced by a deliberately
//      configured relay rather than the other way round.

/**
 * @param anchorPane Decorates a pane with its Project Anchor (main.ts wraps
 *   `resolveProjectAnchor`). Applied to PANES ONLY — app targets carry their own
 *   glyph via {@link EligibleTarget.app} and are never anchored.
 */
export function composePickerTargets(
  herdrResult: HerdrQueryResult,
  apps: readonly EligibleTarget[],
  anchorPane: (target: EligibleTarget) => EligibleTarget,
): HerdrQueryResult {
  if (herdrResult.kind === "targets") {
    const reserve = Math.min(apps.length, MAX_ELIGIBLE_TARGETS);
    const paneRoom = MAX_ELIGIBLE_TARGETS - reserve;
    const panes = herdrResult.targets.slice(0, paneRoom).map(anchorPane);
    return { ...herdrResult, targets: [...panes, ...apps] };
  }

  // Herdr unavailable / incompatible / failed. App targets are not panes, so
  // they remain offerable — this is rule 1 above. Guard on apps.length so a
  // zero-config machine is byte-identical to today (the failure message and its
  // "Clipboard only" picker survive untouched).
  if (apps.length > 0) {
    return { kind: "targets", targets: [...apps] };
  }
  return herdrResult;
}
