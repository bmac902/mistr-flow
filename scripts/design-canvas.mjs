// Snapshot the LIVE overlay into design-canvas/ so a Claude Design session starts
// from the real code, not an old storyboard. This is the whole fix for "every
// export fights the code": if design edits on top of the current overlay.html,
// its export is a superset (it already contains capture-preview, the current
// card DOM, everything the code added) and drops straight back in.
//
//   npm run design:canvas   → writes design-canvas/overlay.html
//
// Load THAT file into Claude Design as the starting point. Edit the butler,
// re-export, drop it back onto public/overlay.html, then run `npm run design:check`.
import { copyFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const SRC = "public/overlay.html";
const OUT_DIR = "design-canvas";
const OUT = `${OUT_DIR}/overlay.html`;

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(SRC, OUT);

let head = "unknown";
try {
  head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // not a git checkout / git unavailable — the snapshot is still valid
}

console.log(`✓ Canvas snapshotted from ${SRC} (at commit ${head})`);
console.log(`  → ${OUT}`);
console.log("");
console.log("Next:");
console.log("  1. Load that file into Claude Design as the starting canvas.");
console.log("  2. Edit only the butler (SVG + mascot CSS + keyframes + copy).");
console.log("  3. Re-export, drop it onto public/overlay.html.");
console.log("  4. Run `npm run design:check` before trusting it.");
console.log("");
console.log("Note: overlay-renderer.js is code-owned. Ignore whatever the export bundles for it.");
