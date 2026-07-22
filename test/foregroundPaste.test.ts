import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureDeliverOutcome } from "../src/captureSession";
import {
  runForegroundPaste,
  type ForegroundPasteDeps,
} from "../src/foregroundPaste";

// The bare Ctrl+Alt+V path (issue #101): no picker open, so paste the NEWEST
// capture-ring entry into the foreground window. An empty ring is a truthful
// refusal — never a paste, never a faked success. This is the pure orchestrator;
// main.ts wires it to the real ring, the foreground delivery adapter, and the
// overlay beats.

interface Entry {
  readonly id: string;
}

function makeDeps(
  overrides: Partial<ForegroundPasteDeps<Entry>> = {},
): { deps: ForegroundPasteDeps<Entry>; log: string[] } {
  const log: string[] = [];
  const deps: ForegroundPasteDeps<Entry> = {
    entry: () => ({ id: "newest" }),
    async deliver(entry) {
      log.push(`deliver:${entry.id}`);
      return { kind: "delivered" } as CaptureDeliverOutcome;
    },
    showNothingCaptured() {
      log.push("nothing-captured");
    },
    showPasted() {
      log.push("pasted");
    },
    showFailed(message) {
      log.push(`failed:${message}`);
    },
    ...overrides,
  };
  return { deps, log };
}

test("a non-empty ring delivers the newest entry to the foreground, then shows the pasted beat", async () => {
  const { deps, log } = makeDeps();

  const result = await runForegroundPaste(deps);

  assert.deepEqual(result, { kind: "pasted" });
  assert.deepEqual(log, ["deliver:newest", "pasted"]);
});

test("an empty ring produces the truthful refusal — no delivery, no faked success", async () => {
  const { deps, log } = makeDeps({ entry: () => null });

  const result = await runForegroundPaste(deps);

  assert.deepEqual(result, { kind: "nothing-captured" });
  // The refusal beat, and crucially NOT a deliver call or a "pasted" success.
  assert.deepEqual(log, ["nothing-captured"]);
});

test("a failed foreground delivery shows the truthful failure beat, never a faked paste", async () => {
  const { deps, log } = makeDeps({
    async deliver(entry) {
      log.push(`deliver:${entry.id}`);
      return {
        kind: "failed",
        code: "delivery-file-missing",
        message: "That capture's gone missing — nothing to deliver, sir.",
      } as CaptureDeliverOutcome;
    },
  });

  const result = await runForegroundPaste(deps);

  assert.equal(result.kind, "paste-failed");
  assert.deepEqual(log, [
    "deliver:newest",
    "failed:That capture's gone missing — nothing to deliver, sir.",
  ]);
});

test("the entry accessor is read once, at fire time — the newest at THIS press", async () => {
  let reads = 0;
  const { deps } = makeDeps({
    entry: () => {
      reads += 1;
      return { id: `read-${reads}` };
    },
  });

  await runForegroundPaste(deps);
  assert.equal(reads, 1, "the ring is read exactly once per press");
});
