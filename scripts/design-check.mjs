// Guardrail: verify an overlay.html still satisfies the production renderer's DOM
// contract BEFORE it's trusted. A Claude Design export is authored from a butler
// storyboard that can lag the code — if it drops an element the renderer drives
// (e.g. #capture-preview), the app breaks silently. This turns that into a loud,
// immediate failure naming exactly which hook is missing.
//
//   npm run design:check                 → checks public/overlay.html
//   npm run design:check -- some/other.html
//
// The contract is derived, not hand-maintained: every id the renderer grabs via
// getElementById must exist in the HTML. Add a new getElementById and this check
// starts requiring it automatically.
import { readFileSync } from "node:fs";

const RENDERER = "public/overlay-renderer.js";
const target = process.argv[2] ?? "public/overlay.html";

const renderer = readFileSync(RENDERER, "utf8");
const html = readFileSync(target, "utf8");

const ids = [
  ...new Set(
    [...renderer.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]),
  ),
].sort();

const missing = ids.filter((id) => !html.includes(`id="${id}"`));

if (missing.length > 0) {
  console.error(`✗ ${target} is missing ${missing.length} DOM hook(s) the renderer drives:`);
  for (const id of missing) console.error(`    #${id}`);
  console.error("");
  console.error("This export lags the code. Re-export from a fresh `npm run design:canvas`,");
  console.error("or re-graft the missing element(s) verbatim before integrating.");
  process.exit(1);
}

console.log(`✓ ${target} satisfies the renderer DOM contract (${ids.length} hooks present).`);
